import crypto from 'node:crypto';
import {cryptPage,parseWal,reconstruct} from './wxsqlite.mjs';

const sha256=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const requireThat=(ok,code)=>{if(!ok)throw new Error(code);};
const usableWal=wal=>['none','empty','partial_frame'].includes(wal.tail)||(wal.tail==='salt_mismatch'&&wal.committedFrames>0);
export function databasePageSize(db){
  requireThat(db.length>=512,'database_too_small');
  const field=db.readUInt16BE(16),pageSize=field===1?65536:field;
  requireThat(pageSize>=512&&pageSize<=65536&&(pageSize&(pageSize-1))===0,'database_page_size');
  requireThat(db.length%pageSize===0,'database_partial_page');return pageSize;
}
export function encryptedPageHashes(db,pageSize){
  const result=[];for(let offset=0;offset<db.length;offset+=pageSize)result.push(sha256(db.subarray(offset,offset+pageSize)));return result;
}
const latestFrames=(frames,start=0,end=frames.length)=>{
  const latest=new Map();for(let i=start;i<end;i++)latest.set(frames[i].pgno,frames[i].data);return latest;
};
const normalizePage=(page,pgno)=>{const out=Buffer.from(page);if(pgno===1){out[18]=1;out[19]=1;}return out;};

export function bootstrapMirror(db,walBytes,key){
  const pageSize=databasePageSize(db),wal=parseWal(walBytes);
  requireThat(!wal.pageSize||wal.pageSize===pageSize,'wal_db_page_size_mismatch');
  requireThat(usableWal(wal),'wal_validation_failed');
  const mirror=reconstruct(db,wal,key),baseHashes=encryptedPageHashes(db,pageSize),pageCipherHashes=baseHashes.slice();
  const walLatest=latestFrames(wal.frames,0,wal.committedFrames);for(const [pgno,data] of walLatest)pageCipherHashes[pgno-1]=sha256(data);
  pageCipherHashes.length=mirror.length/pageSize;
  return {mirror,state:{schemaVersion:1,sequence:1,pageSize,baseHashes,pageCipherHashes,walSalt:wal.salt,
    appliedFrames:wal.committedFrames,dbPages:mirror.length/pageSize,updatedAt:new Date().toISOString()},
    stats:{mode:'bootstrap',basePagesDecrypted:db.length/pageSize,walPagesDecrypted:new Set(wal.frames.slice(0,wal.committedFrames).map(f=>f.pgno)).size}};
}

export function planIncremental(db,walBytes,key,state){
  const pageSize=databasePageSize(db),wal=parseWal(walBytes);
  requireThat(state?.schemaVersion===1&&state.pageSize===pageSize,'mirror_state_incompatible');
  requireThat(!wal.pageSize||wal.pageSize===pageSize,'wal_db_page_size_mismatch');
  requireThat(usableWal(wal),'wal_validation_failed');
  const hashes=encryptedPageHashes(db,pageSize),baseChanged=[];
  const count=Math.max(hashes.length,state.baseHashes.length);
  for(let i=0;i<count;i++)if(hashes[i]!==state.baseHashes[i])baseChanged.push(i+1);
  const sameGeneration=wal.salt===state.walSalt&&wal.committedFrames>=state.appliedFrames;
  const committedLatest=latestFrames(wal.frames,0,wal.committedFrames);
  const targetPages=wal.dbPages??hashes.length;
  requireThat(targetPages*pageSize<=512*1024*1024,'database_size_limit');
  const patches=new Map(),decrypt=(bytes,pgno,kind)=>{
    const page=normalizePage(cryptPage(bytes,key,pgno),pgno);patches.set(pgno,page);stats[kind]++;};
  const stats={mode:'incremental',sameWalGeneration:sameGeneration,basePagesChanged:baseChanged.length,
    basePagesDecrypted:0,walPagesDecrypted:0,baseVersionsAlreadyApplied:0,skippedUnchangedBasePages:hashes.length-baseChanged.length};
  const pageCipherHashes=(state.pageCipherHashes??state.baseHashes).slice();
  for(let pgno=1;pgno<=targetPages;pgno++){
    if(committedLatest.has(pgno))continue;
    const hash=hashes[pgno-1];
    requireThat(hash,'missing_committed_page');
    if(hash===pageCipherHashes[pgno-1]){
      if(hash!==state.baseHashes[pgno-1])stats.baseVersionsAlreadyApplied++;
      continue;
    }
    decrypt(db.subarray((pgno-1)*pageSize,pgno*pageSize),pgno,'basePagesDecrypted');pageCipherHashes[pgno-1]=hash;
  }
  for(const [pgno,data] of committedLatest){if(pgno>targetPages)continue;const hash=sha256(data);if(hash===pageCipherHashes[pgno-1])continue;decrypt(data,pgno,'walPagesDecrypted');pageCipherHashes[pgno-1]=hash;}
  pageCipherHashes.length=targetPages;
  const nextState={schemaVersion:1,sequence:state.sequence+1,pageSize,baseHashes:hashes,pageCipherHashes,walSalt:wal.salt,
    appliedFrames:wal.committedFrames,dbPages:targetPages,updatedAt:new Date().toISOString()};
  return {patches,targetPages,nextState,stats};
}
