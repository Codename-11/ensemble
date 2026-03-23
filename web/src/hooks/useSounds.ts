/**
 * useSounds — Web Audio API synthesized sound effects for Agent-Forge.
 * No audio files needed — pure synthesis.
 * Mute state is persisted in localStorage. Default: muted.
 */
import { useCallback, useRef } from 'react'

const MUTE_KEY = 'ensemble:sounds:muted'

function getMuted(): boolean {
  try {
    const val = localStorage.getItem(MUTE_KEY)
    return val === null ? true : val === 'true'
  } catch {
    return true
  }
}

function setMuted(muted: boolean): void {
  try {
    localStorage.setItem(MUTE_KEY, muted ? 'true' : 'false')
  } catch { /* ignore */ }
}

function getAudioContext(): AudioContext | null {
  try {
    return new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)()
  } catch {
    return null
  }
}

function playTone(
  ctx: AudioContext,
  frequency: number,
  startTime: number,
  duration: number,
  type: OscillatorType = 'sine',
  gainValue = 0.15,
) {
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.connect(gain)
  gain.connect(ctx.destination)

  osc.type = type
  osc.frequency.setValueAtTime(frequency, startTime)

  gain.gain.setValueAtTime(gainValue, startTime)
  gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration)

  osc.start(startTime)
  osc.stop(startTime + duration)
}

export function useSounds() {
  const mutedRef = useRef<boolean>(getMuted())

  const isMuted = useCallback(() => mutedRef.current, [])

  const toggleMute = useCallback(() => {
    mutedRef.current = !mutedRef.current
    setMuted(mutedRef.current)
    return mutedRef.current
  }, [])

  const setMuteState = useCallback((muted: boolean) => {
    mutedRef.current = muted
    setMuted(muted)
  }, [])

  /** Agent join: ascending chime — two quick notes */
  const playJoin = useCallback(() => {
    if (mutedRef.current) return
    const ctx = getAudioContext()
    if (!ctx) return
    const now = ctx.currentTime
    playTone(ctx, 880, now, 0.15, 'sine', 0.12)
    playTone(ctx, 1108, now + 0.12, 0.2, 'sine', 0.1)
    setTimeout(() => ctx.close(), 500)
  }, [])

  /** New message: soft click/pop */
  const playMessage = useCallback(() => {
    if (mutedRef.current) return
    const ctx = getAudioContext()
    if (!ctx) return
    const now = ctx.currentTime
    playTone(ctx, 800, now, 0.06, 'triangle', 0.08)
    playTone(ctx, 600, now + 0.04, 0.08, 'sine', 0.05)
    setTimeout(() => ctx.close(), 300)
  }, [])

  /** Plan update: gentle bell */
  const playPlan = useCallback(() => {
    if (mutedRef.current) return
    const ctx = getAudioContext()
    if (!ctx) return
    const now = ctx.currentTime
    playTone(ctx, 1047, now, 0.4, 'sine', 0.1)
    playTone(ctx, 1319, now + 0.05, 0.3, 'sine', 0.07)
    playTone(ctx, 1568, now + 0.1, 0.35, 'sine', 0.05)
    setTimeout(() => ctx.close(), 800)
  }, [])

  /** Team disband: descending tone */
  const playDisband = useCallback(() => {
    if (mutedRef.current) return
    const ctx = getAudioContext()
    if (!ctx) return
    const now = ctx.currentTime
    playTone(ctx, 660, now, 0.15, 'sine', 0.12)
    playTone(ctx, 523, now + 0.12, 0.15, 'sine', 0.1)
    playTone(ctx, 392, now + 0.25, 0.3, 'sine', 0.08)
    setTimeout(() => ctx.close(), 800)
  }, [])

  return { playJoin, playMessage, playPlan, playDisband, isMuted, toggleMute, setMuteState }
}

export { getMuted, setMuted }
