import { act,create,type ReactTestRenderer } from 'react-test-renderer'
import {afterEach,describe,it,expect,vi} from 'vitest'
import {ArkmeRecordDeletionDialog} from '../src/client/ArkmeRecordDeletionDialog.js'
import {ArkmeConfirmDialog} from '../src/client/ArkmeConfirmDialog.js'
let view:ReactTestRenderer|undefined
afterEach(async()=>{await act(async()=>view?.unmount());view=undefined})
const result={items:[{recordUid:'a',version:2,result:'deleted' as const}],projectionRefreshPending:true}
const props=()=>({sourceRef:'source',deletionRefs:['ref'],port:{delete:vi.fn(async()=>result)},onCancel:vi.fn(),onResult:vi.fn(),onRefresh:vi.fn()})
describe('record deletion confirmation',()=>{
 it('does not write until confirmed and leaves cancel harmless',async()=>{const p=props();await act(async()=>{view=create(<ArkmeRecordDeletionDialog {...p}/>)});expect(p.port.delete).not.toHaveBeenCalled();act(()=>view!.root.findByType(ArkmeConfirmDialog).props.onClose());expect(p.onCancel).toHaveBeenCalledOnce();expect(p.port.delete).not.toHaveBeenCalled()})
 it('prevents same-frame duplicate clicks',async()=>{const p=props();await act(async()=>{view=create(<ArkmeRecordDeletionDialog {...p}/>)});await act(async()=>{const confirm=view!.root.findByType(ArkmeConfirmDialog).props.onConfirm;confirm();confirm()});expect(p.port.delete).toHaveBeenCalledOnce();expect(p.onResult).toHaveBeenCalledWith(result)})
 it('blocks blind retry after unknown failure',async()=>{const p=props();p.port.delete.mockRejectedValue(new Error('网络中断'));await act(async()=>{view=create(<ArkmeRecordDeletionDialog {...p}/>)});await act(async()=>view!.root.findByType(ArkmeConfirmDialog).props.onConfirm());expect(p.onResult).not.toHaveBeenCalled();expect(view!.root.findByType(ArkmeConfirmDialog).props.confirmLabel).toBe('刷新核对');await act(async()=>view!.root.findByType(ArkmeConfirmDialog).props.onConfirm());expect(p.onRefresh).toHaveBeenCalledOnce();expect(p.port.delete).toHaveBeenCalledOnce()})
 it('ignores completion after unmount',async()=>{const p=props();let finish!:(r:typeof result)=>void;p.port.delete.mockImplementation(()=>new Promise(r=>{finish=r}));await act(async()=>{view=create(<ArkmeRecordDeletionDialog {...p}/>)});act(()=>view!.root.findByType(ArkmeConfirmDialog).props.onConfirm());await act(async()=>{view!.unmount();finish(result)});expect(p.onResult).not.toHaveBeenCalled()})
})
