// Audio conversion between Twilio Media Streams (8 kHz G.711 mu-law) and Rime Prism (PCM16).

// Decode mu-law bytes to PCM16 samples. From Rime's docs.
export function mulawToPcm16(mulaw) {
    const pcm = Buffer.alloc(mulaw.length * 2);
    mulaw.forEach((value, i) => {
        const byte = ~value & 0xff;
        const magnitude = (((byte & 0x0f) << 3) + 0x84) << ((byte >> 4) & 0x07);
        pcm.writeInt16LE(byte & 0x80 ? 0x84 - magnitude : magnitude - 0x84, i * 2);
    });
    return pcm;
}

// Encode one PCM16 sample as a mu-law byte (the reverse of mulawToPcm16).
function encodeMulaw(sample) {
    const sign = sample < 0 ? 0x80 : 0;
    const magnitude = Math.min(Math.abs(sample), 32635) + 0x84;
    const exponent = 24 - Math.clz32(magnitude); // Which of mu-law's 8 loudness ranges the sample is in
    const mantissa = (magnitude >> (exponent + 3)) & 0x0f;
    return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

// Keep every third sample (24 kHz to 8 kHz). But first, filter out everything above 4 kHz.
// This low-pass filter cuts off at 3.6 kHz. https://en.wikipedia.org/wiki/G.711
const TAPS = 95;
const FILTER = Array.from({ length: TAPS }, (_, i) => {
    const n = i - (TAPS - 1) / 2;
    const cutoff = 3600 / 24000;
    const sinc = n === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * n) / (Math.PI * n);
    return sinc * (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (TAPS - 1)));
});

// Convert 24 kHz PCM16 chunks to 8 kHz mu-law.
export function createReplyEncoder() {
    let history = new Float64Array(TAPS - 1); // The end of the previous chunk
    return (pcm24k) => {
        const pcm = Buffer.from(pcm24k.buffer, pcm24k.byteOffset, pcm24k.byteLength);
        const input = new Float64Array(history.length + pcm.length / 2);
        input.set(history);
        for (let i = history.length; i < input.length; i++) input[i] = pcm.readInt16LE((i - history.length) * 2);
        // Each output sample filters TAPS input samples.
        const mulaw = Buffer.alloc(Math.max(0, Math.floor((input.length - TAPS) / 3) + 1));
        for (let out = 0; out < mulaw.length; out++) {
            let sum = 0;
            for (let t = 0; t < TAPS; t++) sum += FILTER[t] * input[out * 3 + t];
            mulaw[out] = encodeMulaw(Math.round(sum));
        }
        history = input.subarray(mulaw.length * 3);
        return mulaw;
    };
}
