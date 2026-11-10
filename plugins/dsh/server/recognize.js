import {execFile, spawn} from 'node:child_process';
import {access, mkdtemp, readFile, stat, rm, writeFile} from 'node:fs/promises';
import {homedir, tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {mediaResponse} from './media.js';

const run = promisify(execFile);
const ocr = fileURLToPath(new URL('../dist/wecom-ocr', import.meta.url));
const options = {timeout: 120_000, maxBuffer: 1024 * 1024};

async function executable(configured, name) {
  for (const path of [configured, `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`]) {
    if (!path) continue;
    try { await access(path, 1); return path; } catch {}
  }
}

export async function recognitionTools() {
  const model = process.env.WECOM_WHISPER_MODEL ??
    join(homedir(), 'Library', 'Application Support', 'WeComAgent', 'models', 'ggml-small-q5_1.bin');
  const [ffmpeg, whisper, modelReady] = await Promise.all([
    executable(process.env.WECOM_FFMPEG, 'ffmpeg'),
    executable(process.env.WECOM_WHISPER, 'whisper-cli'),
    access(model, 4).then(() => true, () => false),
  ]);
  return {ffmpeg, whisper, model: modelReady ? model : undefined};
}

export async function extractionVersion(kind, tools) {
  const paths = kind === 'image' ? [ocr] : [tools.whisper, tools.ffmpeg, tools.model];
  if (paths.some(path => !path)) return null;
  try {
    return await Promise.all(paths.map(async path => {
      const file = await stat(path, {bigint: true});
      return [String(file.dev), String(file.ino), String(file.size), String(file.mtimeNs)];
    }));
  } catch { return null; }
}

function recognizeImage(bytes, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(ocr, [], {stdio: ['pipe', 'pipe', 'ignore'], signal});
    let output = '';
    const timeout = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', text => {
      output += text;
      if (output.length > 64_000) child.kill('SIGKILL');
    });
    child.stdin.on('error', reject);
    child.once('error', reject);
    child.once('close', code => {
      clearTimeout(timeout);
      if (code === 0) resolve(output.trim() ? [{text: output.trim()}] : []);
      else reject(Error('recognition_failed'));
    });
    child.stdin.end(bytes);
  });
}

export async function recognize(file, kind, tools, signal) {
  signal.throwIfAborted();
  if (kind === 'voice' && (!tools.ffmpeg || !tools.whisper || !tools.model)) throw Error('voice_setup_required');
  if (!file || file.size > 16 * 1024 * 1024) throw Error('media_unavailable');
  const response = await mediaResponse(file);
  const mime = response.headers.get('content-type') ?? '';
  if (!mime.startsWith(kind === 'image' ? 'image/' : 'audio/')) {
    await response.body?.cancel();
    throw Error('media_unavailable');
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (kind === 'image') return recognizeImage(bytes, signal);
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-wecom-voice-'));
  try {
    const source = join(scratch, 'source');
    const wav = join(scratch, 'speech.wav');
    const output = join(scratch, 'result');
    await writeFile(source, bytes, {mode: 0o600, signal});
    await run(tools.ffmpeg, ['-nostdin', '-v', 'error', '-i', source, '-t', '600', '-ac', '1', '-ar', '16000', wav],
      {...options, signal});
    await run(tools.whisper, ['-m', tools.model, '-f', wav, '-l', 'auto', '-oj', '-of', output, '-np', '-t', '4'],
      {...options, signal});
    const data = JSON.parse(await readFile(`${output}.json`, 'utf8'));
    return (data.transcription ?? []).flatMap(segment => {
      const text = segment.text?.trim();
      return text ? [{text, startMs: segment.offsets?.from, endMs: segment.offsets?.to}] : [];
    });
  } finally {
    await rm(scratch, {recursive: true, force: true});
  }
}
