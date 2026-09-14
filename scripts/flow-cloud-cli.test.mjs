import {test} from 'node:test';
import assert from 'node:assert/strict';
import {selectCloudRelease, latestCloudRelease} from './flow-cloud-cli.mjs';
const release = tag => ({tag_name: tag, assets: ['flow-browser-darwin-arm64.tar.gz','flow-browser-darwin-arm64.tar.gz.sha256'].map(name => ({name, browser_download_url:`https://github.com/samyakkkk/flow/releases/download/${tag}/${name}`}))});
test('Cloud CLI update selection never consumes desktop or browser releases', () => {
  const selected=selectCloudRelease([release('flow-v999.0.0'),release('flow-desktop-v999.0.0'),release('flow-cloud-cli-v0.1.0'),release('flow-cloud-cli-v0.2.0'),{...release('flow-cloud-cli-v0.3.0'),prerelease:true}], 'darwin-arm64');
  assert.equal(selected.tag,'flow-v0.2.0');
  assert.match(selected.archiveUrl,/flow-cloud-cli-v0.2.0/);
});
test('rejects missing or substituted platform assets',()=>{
  assert.throws(()=>selectCloudRelease([release('flow-cloud-cli-v0.1.0')],'linux-x64'),/missing/);
  const r=release('flow-cloud-cli-v0.1.0');r.assets[0].browser_download_url='https://example.com/bundle';
  assert.throws(()=>selectCloudRelease([r],'darwin-arm64'),/missing/);
});
test('update feed failures fail explicitly and have a bounded request',async()=>{
  await assert.rejects(latestCloudRelease(async(url, options)=>{
    assert.ok(options.signal);return new Response('',{status:503});
  }),/503/);
});
