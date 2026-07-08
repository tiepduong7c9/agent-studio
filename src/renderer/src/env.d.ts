import type { StudioApi } from '../../preload/index'

declare global {
  interface Window {
    studio: StudioApi
  }
}

export {}
