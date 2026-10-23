import Fastify from 'fastify';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import { Rime, runConversation } from '@rimelabs/sdk';
import { createReplyEncoder, mulawToPcm16 } from './audio.js';

dotenv.config();

if (!process.env.RIME_API_KEY) {
    console.error('Missing Rime API key. Please set it in the .env file.');
    process.exit(1);
}

const VOICE = 'astra';
const PORT = process.env.PORT || 5050;

// Send Twilio a mark at least every 100 ms of audio. Our rough benchmarks were ~300 ms per word, so 
// this interval is around 1/3 of a word.
const MARK_INTERVAL_MS = 100;

const OPENING = "Ahoy! I'm an AI voice assistant powered by Twilio and Rime's Prism. How can I help?";
const INSTRUCTIONS = "You are an AI voice assistant powered by Twilio and Rime's Prism, and on a live phone call. "
    + 'Everything you say is spoken to the caller. Use plain spoken sentences, with no markdown, lists, or symbols. '
    + 'Spell out all numbers, for example "twenty-three". Answer in one to three short sentences. '
    + 'You are cheerful, with a penchant for dad jokes, owl jokes, and slipping an 80s song lyric into an answer. '
    + 'Never say it is a lyric or name the song, but you can joke about it. '
    + 'You want everyone to answer the phone with "ahoy". '
    + 'Call get_current_time before you answer any question about the current time or date.';

const TIME_TOOL = {
    name: 'get_current_time',
    description: 'Get the current date and time in a time zone.',
    parameters: {
        type: 'object',
        properties: { timezone: { type: 'string', description: 'An IANA time zone, for example America/New_York' } },
    },
};

// Mock tool call. Add your own tool logic here.
const getCurrentTime = ({ timezone = 'America/Los_Angeles' }) => {
    console.log('Synchronizing watches...');
    return { timezone, now: new Date().toLocaleString('en-US', { timeZone: timezone, dateStyle: 'full', timeStyle: 'short' }) };
};

const rime = new Rime();
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

fastify.get('/', async () => ({ message: 'Twilio Media Stream Server is running!' }));

// Some tunnels rewrite the Host header. Set PUBLIC_HOST if you use one.
fastify.all('/incoming-call', async (request, reply) => {
    const host = process.env.PUBLIC_HOST || request.headers['x-forwarded-host'] || request.headers.host;
    reply.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response><Connect><Stream url="wss://${host}/media-stream" /></Connect></Response>`);
});

// Queue the caller's audio from Twilio until Prism needs it.
function createCallerAudio() {
    const frames = [];
    let waiting = null; // A read() waiting for the next frame
    return {
        push(frame) {
            if (waiting) waiting(frame);
            else frames.push(frame);
        },
        read(signal) {
            if (frames.length) return Promise.resolve(frames.shift());
            return new Promise((resolve, reject) => {
                const abort = () => reject(signal.reason);
                signal.addEventListener('abort', abort, { once: true });
                waiting = (frame) => {
                    waiting = null;
                    signal.removeEventListener('abort', abort);
                    resolve(frame);
                };
            });
        },
    };
}

// Play Prism's replies on the call. Twilio doesn't report how much audio has played, so we use a mark message.
// When Twilio sends a markback, we can infer the caller has heard that much.
function createTwilioPlayback(twilio, streamSid) {
    const send = (message) => twilio.send(JSON.stringify({ streamSid, ...message }));
    const replies = new Map(); // Replies still playing
    let nextId = 0;
    const finish = (reply, heardMs) => { replies.delete(reply.id); reply.resolve(heardMs); };

    return {
        // Prism started a reply. The SDK writes the reply's audio to the object we return.
        open(ref) {
            const reply = { id: String(nextId++), ref, sentMs: 0, heardMs: 0, ...Promise.withResolvers() };
            replies.set(reply.id, reply);
            const encode = createReplyEncoder();
            return {
                write(chunk) {
                    if (!replies.has(reply.id)) return; // The caller interrupted this reply.
                    const mulaw = encode(chunk.data);
                    const step = MARK_INTERVAL_MS * 8; // 8 kHz mu-law is 8 bytes per millisecond.
                    for (let start = 0; start < mulaw.length; start += step) {
                        const piece = mulaw.subarray(start, start + step);
                        send({ event: 'media', media: { payload: piece.toString('base64') } });
                        reply.sentMs += piece.length / 8;
                        send({ event: 'mark', mark: { name: `${reply.id}:${reply.sentMs}` } });
                    }
                },
                // Prism sent the last of this reply. When this mark comes back, the caller heard all of it.
                end() {
                    if (replies.has(reply.id)) send({ event: 'mark', mark: { name: `${reply.id}:end` } });
                },
                // Resolves with how much of the reply the caller heard.
                completion: () => reply.promise,
            };
        },
        // The caller talked over these replies. Empty Twilio's buffer and report what the caller heard.
        interrupt(refs) {
            const stopped = [...replies.values()].filter((reply) => refs.includes(reply.ref));
            if (stopped.length) send({ event: 'clear' });
            for (const reply of stopped) {
                console.log(`Interrupted after ${Math.round(reply.heardMs)} of ${Math.round(reply.sentMs)} ms`);
                finish(reply, reply.heardMs);
            }
        },
        // The conversation ended. Resolve every reply that's still playing.
        stop() {
            for (const reply of replies.values()) finish(reply, reply.heardMs);
        },
        // Twilio played everything up to this mark.
        onMark(name) {
            const [id, position] = name.split(':');
            const reply = replies.get(id);
            if (reply && position === 'end') finish(reply, reply.sentMs);
            else if (reply) reply.heardMs = Number(position);
        },
    };
}

// Run the tool, then ask Prism to continue its reply with the result.
async function runTool(session, { call, name, arguments: args }) {
    console.log('Tool call:', name, args);
    let result;
    try {
        result = name === TIME_TOOL.name ? getCurrentTime(args) : { error: 'unknown tool' };
    } catch {
        result = { error: `${name} failed` };
    }
    await session.submitToolResult(call, JSON.stringify(result));
    await session.continueReply(call);
}

// Log the conversation. The SDK needs this function to return right away.
function onEvent(session, { payload }) {
    switch (payload.kind) {
        case 'speech.started':
            return console.log('Caller started speaking');
        case 'transcript.final':
            return console.log('Caller:', payload.text);
        case 'text.done':
            return console.log('Assistant:', payload.text);
        case 'tool.call':
            return void runTool(session, payload)
                .catch((error) => console.log('Tool round ended early:', error.fault?.code ?? error.message));
        case 'error':
            return console.error('Prism error:', payload.error.code, payload.error.message);
    }
}

// Open one Prism session for the call, greet the caller, and run the conversation.
async function converse(callerAudio, playback) {
    const session = await rime.realtime.connect({ voice: VOICE, instructions: INSTRUCTIONS, tools: [TIME_TOOL] });

    // Quote this ID if you ever need Rime's help with a call.
    console.log('Prism session', session.info.sessionId);
    session.requestReply({ instruction: `Say, word for word: "${OPENING}"` })
        .catch((error) => console.error('Greeting failed:', error.message));
    await runConversation(session, { source: callerAudio, playback, onEvent: (event) => onEvent(session, event) });
}

fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection) => {
        console.log('Client connected');
        const callerAudio = createCallerAudio();
        let playback;

        connection.on('message', (message) => {
            const data = JSON.parse(message);
            switch (data.event) {
                case 'start':
                    console.log('Incoming stream has started', data.start.streamSid);
                    playback = createTwilioPlayback(connection, data.start.streamSid);
                    // When the Prism session ends, close the stream. Twilio then hangs up.
                    converse(callerAudio, playback)
                        .catch((error) => console.error('Conversation failed:', error))
                        .finally(() => connection.close());
                    break;
                // Forward every frame, including silence.
                case 'media':
                    callerAudio.push({
                        data: mulawToPcm16(Buffer.from(data.media.payload, 'base64')),
                        format: { sampleRate: 8000 },
                    });
                    break;
                case 'mark':
                    playback?.onMark(data.mark.name);
                    break;
            }
        });

        connection.on('close', () => {
            callerAudio.push(null);
            console.log('Client disconnected.');
        });
    });
});

fastify.listen({ port: PORT }, (err) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log(`Server is listening on port ${PORT}`);
});
