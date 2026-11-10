import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {Readable} from 'node:stream';
import {decode, getDuration} from 'silk-wasm';

const maxMediaBytes = 64 * 1024 * 1024;
const voiceSampleRate = 24000;
const maxVoiceBytes = 2 * 1024 * 1024;
const types = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4',
  'audio/wav', 'audio/ogg', 'audio/mp4', 'audio/x-silk', 'application/octet-stream',
]);

async function decodeVoice(bytes) {
  const duration = getDuration(bytes);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 600_000) throw Error('media_unavailable');
  const {data} = await decode(bytes, voiceSampleRate);
  if (!data.length || data.length % 2 || data.length > 600 * voiceSampleRate * 2)
    throw Error('media_unavailable');
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(voiceSampleRate, 24);
  header.writeUInt32LE(voiceSampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function headers(mime, size) {
  return {
    'content-type': mime, 'content-length': String(size), 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  };
}

export async function mediaResponse(file) {
  if (!file || !types.has(file.mime) || !Number.isSafeInteger(file.size) ||
      file.size <= 0 || file.size > maxMediaBytes) throw Error('media_unavailable');
  let handle;
  try {
    handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat({bigint: true});
    if (!stat.isFile() || String(stat.dev) !== file.device || String(stat.ino) !== file.inode ||
        String(stat.mtimeNs) !== file.modified || stat.size !== BigInt(file.size))
      throw Error('media_unavailable');
    if (file.mime === 'audio/x-silk') {
      if (file.size > maxVoiceBytes) throw Error('media_unavailable');
      const bytes = Buffer.alloc(file.size);
      const {bytesRead} = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead !== bytes.length) throw Error('media_unavailable');
      const wav = await decodeVoice(bytes);
      return new Response(wav, {headers: headers('audio/wav', wav.length)});
    }
    const stream = Readable.toWeb(handle.createReadStream({end: file.size - 1}));
    handle = undefined; // The stream closes the descriptor on completion or cancellation.
    return new Response(stream, {headers: headers(file.mime, file.size)});
  } catch {
    throw Error('media_unavailable');
  } finally {
    await handle?.close().catch(() => {});
  }
}
