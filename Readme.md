# Twilio Voice + Rime Prism AI voice assistant (Node.js)

Call a Twilio phone number and talk to an AI voice assistant powered by [Rime's Prism](https://www.rime.ai/prism) speech-to-speech model.

**📖 The full walkthrough is on our blog: [Build an AI Voice Assistant with Twilio Voice and Media Streams, Rime's Prism, and Node.js](https://www.twilio.com/en-us/blog/developers/tutorials/integrations/voice-ai-agent-rime-prism-node).**

## What's in the repo

- `index.js`: a Fastify server. It answers the call with TwiML, then opens a [Twilio Media Stream](https://www.twilio.com/docs/voice/media-streams), and finally connects the call to Prism with [Rime's Node SDK](https://docs.rime.ai/api-reference/sdk/overview). It handles interruptions and includes one example tool, the current time.
- `audio.js`: converts between Twilio's 8 kHz μ-law and Prism's PCM16 audio.

### Optional: memory and call scoring

The [`cintel-optional`](https://github.com/pkamp3/twilio-rime-prism-node/tree/cintel-optional) branch adds Step 7 from the post. It scores each call with [Conversation Intelligence](https://www.twilio.com/docs/conversations/intelligence) and remembers callers with [Conversation Memory](https://www.twilio.com/docs/conversations/memory), so the assistant recognizes a returning caller.

## Quick start

You'll need a [Twilio account](https://www.twilio.com/try-twilio), Node.js 22+, a [Twilio phone number with Voice](https://help.twilio.com/articles/223135247-How-to-Search-for-and-Buy-a-Twilio-Phone-Number-from-Console), a [Rime API key](https://app.rime.ai/tokens), and a publicly accessible URL. We used [ngrok](https://ngrok.com) to test this post.

```bash
npm install
cp .env.example .env   # then set RIME_API_KEY
npm start
```

Expose port 5050 with your tunnel. Then set your Twilio number's incoming-call webhook to `https://<your-tunnel-host>/incoming-call`, and call the number. Have fun! 🦉☎️

## License

MIT
