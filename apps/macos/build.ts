import { copyFile, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { buildMacCore, run } from '../../packages/wecom-core/build';

const here = import.meta.dir;
if (process.platform !== 'darwin' || (process.arch !== 'arm64' && process.arch !== 'x64'))
  throw Error('Build the native app on macOS.');

const swift = ['/usr/bin/swift', 'build', '--package-path', here, '-c', 'release'];
await run(swift);
const pathQuery = Bun.spawn([...swift, '--show-bin-path'], {stdout: 'pipe', stderr: 'inherit'});
const bin = (await new Response(pathQuery.stdout).text()).trim();
if (await pathQuery.exited !== 0 || !bin) throw Error('Could not locate the Swift executable');

const dist = join(here, 'dist');
const app = join(dist, 'WeCom Local.app');
await mkdir(dist, {recursive: true});
const staging = await mkdtemp(join(dist, '.bundle-'));
const bundle = join(staging, 'WeCom Local.app');
try {
  const contents = join(bundle, 'Contents');
  const macOS = join(contents, 'MacOS');
  const resources = join(contents, 'Resources');
  await mkdir(macOS, {recursive: true});
  await mkdir(resources, {recursive: true});
  await copyFile(join(bin, 'WeComLocal'), join(macOS, 'WeComLocal'));
  await copyFile(join(here, 'Resources/Info.plist'), join(contents, 'Info.plist'));
  await copyFile(join(here, 'Resources/AppIcon.icns'), join(resources, 'AppIcon.icns'));
  await buildMacCore(join(macOS, 'wecom-core'), [process.arch]);
  await run(['/usr/bin/codesign', '--force', '--sign', '-', bundle]);
  await run(['/usr/bin/codesign', '--verify', '--deep', '--strict', bundle]);
  await rm(app, {recursive: true, force: true});
  await rename(bundle, app);
  console.log(app);
} finally {
  await rm(staging, {recursive: true, force: true});
}
