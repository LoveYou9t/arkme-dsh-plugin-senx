import { describe,it,expect,vi } from 'vitest'
import { sealRecordDeletionRef, openRecordDeletionRef } from '../src/record-deletion-ref.js'
import { RecordDeletionService, RecordDeletionHttpPort } from '../src/services/record-deletion-service.js'
const ref = { userId: 7, sourceKind: 'private_chat' as const, sourceOwnerRef: 'chat', recordUid: 'record', recordVersion: 3 }
function setup(){
 const port={deleteBatch:vi.fn().mockResolvedValue({items:[{recordUid:'record',version:4,result:'deleted'}],projectionRefreshPending:true})}
 const runtime={invalidateKey:vi.fn(),requestScope:(id:number)=>String(id),requireSession:vi.fn().mockResolvedValue({userId:7}),stateStore:{uniqueCode:async()=> 'key'}}
 const sources={openSourceRef:vi.fn().mockResolvedValue({kind:'private_chat',ownerRef:'chat'}),invalidateSourceListCache:vi.fn()}
 const service=new RecordDeletionService(runtime as never,sources as never,port)
 return {port,runtime,sources,service}
}
describe('record deletion boundary',()=>{
 it('binds version and identity in a distinct signed reference',()=>{
  const value=sealRecordDeletionRef(ref,'key');expect(openRecordDeletionRef(value,'key')).toEqual(ref)
  expect(()=>openRecordDeletionRef(value,'other')).toThrow()
  expect(()=>openRecordDeletionRef(value.replace('arkme-record-delete-v1','arkme-message-action-v1'),'key')).toThrow()
 })
 it.each([{...ref,userId:8},{...ref,sourceOwnerRef:'other'},{...ref,sourceKind:'topic' as const}])('rejects cross-scope references before IO',async other=>{
  const {service,port}=setup();await expect(service.delete('source',[sealRecordDeletionRef(other,'key')])).rejects.toThrow();expect(port.deleteBatch).not.toHaveBeenCalled()
 })
 it('rejects duplicate records and empty selection',async()=>{
  const {service,port}=setup();const value=sealRecordDeletionRef(ref,'key')
  await expect(service.delete('source',[value,value])).rejects.toThrow();await expect(service.delete('source',[])).rejects.toThrow();expect(port.deleteBatch).not.toHaveBeenCalled()
 })
 it('passes observed versions once and invalidates even for unknown outcomes',async()=>{
  const {service,port,sources}=setup();port.deleteBatch.mockRejectedValue(new Error('timeout'))
  await expect(service.delete('source',[sealRecordDeletionRef(ref,'key')])).rejects.toThrow('timeout')
  expect(port.deleteBatch).toHaveBeenCalledTimes(1);expect(port.deleteBatch.mock.calls[0]?.[0]).toEqual([{recordUid:'record',version:3}]);expect(sources.invalidateSourceListCache).toHaveBeenCalled()
 })
 it('rejects account change before mutation',async()=>{
  const {service,port,runtime}=setup();runtime.requireSession.mockResolvedValueOnce({userId:7}).mockResolvedValue({userId:8})
  await expect(service.delete('source',[sealRecordDeletionRef(ref,'key')])).rejects.toThrow();expect(port.deleteBatch).not.toHaveBeenCalled()
 })
 it('validates every owner result and never retries malformed successes',async()=>{
  const post=vi.fn().mockResolvedValue({items:[],projection_refresh_pending:false});const port=new RecordDeletionHttpPort({authenticatedPost:post} as never)
  await expect(port.deleteBatch([{recordUid:'record',version:3}],{userId:7} as never)).rejects.toThrow();expect(post).toHaveBeenCalledTimes(1)
 })
})

import { recordDeletionCapability } from '../src/record-deletion-ref.js'
describe('authoritative deletion capability',()=>{
 const own={userId:7,sourceKind:'private_chat',sourceOwnerRef:'chat',recordUid:'record',recordVersion:3,recordOwnerUserId:7,isMe:true,status:1}
 it('issues the exact owner version',()=>{const ref=recordDeletionCapability(own,'key').recordDeletionRef!;expect(openRecordDeletionRef(ref,'key').recordVersion).toBe(3)})
 it.each([{isMe:false},{recordOwnerUserId:8},{status:2},{recordVersion:0},{recordVersion:1.5},{sourceKind:'agent'},{sourceKind:'bot_subject'}])('does not grant for unsupported or foreign facts %s',override=>{expect(recordDeletionCapability({...own,...override},'key')).toEqual({})})
})
