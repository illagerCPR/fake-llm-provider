import type { Frame } from './types'

/** 把一帧编码成 SSE 文本；注释帧不带 data:，客户端会直接忽略 */
export function serializeFrame(frame: Frame): string {
  if (frame.kind === 'comment') return `: ${frame.text}\n\n`
  let out = ''
  if (frame.event) out += `event: ${frame.event}\n`
  out += `data: ${frame.data}\n\n`
  return out
}

export function serializeFrames(frames: Frame[]): string {
  let out = ''
  for (const frame of frames) out += serializeFrame(frame)
  return out
}

export const DONE_DATA = '[DONE]'

/** OpenAI 流式结束标记 */
export const DONE_FRAME: Frame = { kind: 'event', data: DONE_DATA }

/** 流式响应头：关掉各种缓冲，保证逐块可见 */
export const STREAM_HEADERS: Record<string, string> = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
}
