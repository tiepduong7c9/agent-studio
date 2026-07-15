import { create } from 'zustand'
import type { TransferProgress } from '../../shared/types'

// Active upload/download transfers, mirrored from the main process's fs:progress
// events (see App's subscription). The status bar renders these live; entries
// appear on 'start', update on 'progress', and are removed on 'end'.

export interface Transfer {
  id: string
  kind: 'upload' | 'download'
  name: string
  /** Total bytes, or 0 when unknown (shown as indeterminate). */
  total: number
  transferred: number
}

interface TransferStore {
  transfers: Transfer[]
  apply: (p: TransferProgress) => void
}

export const useTransferStore = create<TransferStore>((set) => ({
  transfers: [],
  apply: (p) =>
    set((s) => {
      if (p.phase === 'start') {
        return {
          transfers: [
            ...s.transfers,
            { id: p.id, kind: p.kind, name: p.name, total: p.total, transferred: 0 }
          ]
        }
      }
      if (p.phase === 'progress') {
        return {
          transfers: s.transfers.map((t) =>
            t.id === p.id ? { ...t, transferred: p.transferred } : t
          )
        }
      }
      return { transfers: s.transfers.filter((t) => t.id !== p.id) }
    })
}))
