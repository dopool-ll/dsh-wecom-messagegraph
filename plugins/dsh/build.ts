import {chmod, mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {buildMacCore} from '../../packages/wecom-core/build';

if (process.platform !== 'darwin') throw Error('Build the Mac plugin on macOS.');
const here = import.meta.dir;
const dist = join(here, 'dist');
await mkdir(dist, {recursive: true});
const result = await Bun.build({
  entrypoints: [join(here, 'client/index.tsx')],
  format: 'cjs',
  target: 'browser',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  plugins: [{
    name: 'raw-styles',
    setup(build) {
      build.onResolve({filter: /\.css\?raw$/}, args => ({
        path: join(args.resolveDir, args.path.slice(0, -4)),
        namespace: 'raw-styles',
      }));
      build.onLoad({filter: /.*/, namespace: 'raw-styles'}, async args => ({
        contents: await Bun.file(args.path).text(), loader: 'text',
      }));
    },
  }],
  tsconfig: join(here, 'tsconfig.json'),
  jsx: {runtime: 'automatic', development: false},
  minify: true,
});
if (!result.success) throw new AggregateError(result.logs, 'Could not build the DSH client');
const code = await result.outputs[0].text();
await writeFile(join(dist, 'client.js'), `window.__ModuleLoader__.load({
  id: 'dsh-wecom-local',
  factory(require) {
    const module = { exports: {} };
    const exports = module.exports;
    ${code}
    return module.exports;
  },
});\n`);

const cli = await Bun.build({
  entrypoints: [join(here, 'server/messagegraph-cli.js')],
  outdir: dist,
  naming: 'messagegraph.mjs',
  target: 'node',
  format: 'esm',
  minify: true,
});
if (!cli.success) throw new AggregateError(cli.logs, 'Could not build MessageGraph CLI');
await chmod(join(dist, 'messagegraph.mjs'), 0o755);

await buildMacCore(join(dist, 'wecom-core'), ['arm64', 'x64']);

const ocrTargets = ['arm64', 'x86_64'];
await Promise.all(ocrTargets.map(async arch => {
  const build = await Bun.$`xcrun swiftc -O -target ${arch}-apple-macos13.0 ${join(here, 'server/ocr.swift')} -o ${join(dist, `wecom-ocr-${arch}`)}`.quiet();
  if (build.exitCode) throw Error(build.stderr.toString());
}));
await Bun.$`xcrun lipo -create ${ocrTargets.map(arch => join(dist, `wecom-ocr-${arch}`))} -output ${join(dist, 'wecom-ocr')}`;
