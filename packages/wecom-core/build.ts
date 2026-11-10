import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export async function run(command: string[], cwd?: string) {
  const child = Bun.spawn(command, {cwd, stdout: 'inherit', stderr: 'inherit'});
  if (await child.exited !== 0) throw Error(`${command[0]} failed`);
}

type MacArch = 'arm64' | 'x64';

export async function buildMacCore(destination: string, architectures: MacArch[]) {
  if (process.platform !== 'darwin') throw Error('Build the macOS helper on macOS.');
  const output = resolve(destination);
  const entry = join(import.meta.dir, 'src/main.ts');
  await mkdir(dirname(output), {recursive: true});
  const scratch = await mkdtemp(join(tmpdir(), 'wecom-core-'));
  try {
    const slices = [];
    for (const arch of architectures) {
      const slice = join(scratch, `wecom-core-${arch}`);
      await run([process.execPath, 'build', entry, '--compile', `--target=bun-darwin-${arch}`, '--outfile', slice]);
      slices.push(slice);
    }
    if (slices.length === 1) await Bun.write(output, Bun.file(slices[0]));
    else await run(['/usr/bin/lipo', '-create', ...slices, '-output', output]);
    await chmod(output, 0o755);
    await run(['/usr/bin/codesign', '--force', '--sign', '-', output]);
    await run(['/usr/bin/codesign', '--verify', '--strict', '--all-architectures', output]);
  } finally {
    await rm(scratch, {recursive: true, force: true});
  }
}
