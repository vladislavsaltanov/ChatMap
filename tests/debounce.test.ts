import { describe, expect, it, vi } from 'vitest'
import { debounce } from '../src/core/debounce'

describe('debounce', () => {
  it('coalesces multiple rapid calls into a single invocation', () => {
    vi.useFakeTimers()
    const fn = vi.fn()
    const debounced = debounce(fn, 100)

    debounced(1)
    debounced(2)
    debounced(3)

    expect(fn).not.toHaveBeenCalled()

    vi.advanceTimersByTime(50)
    expect(fn).not.toHaveBeenCalled()

    vi.advanceTimersByTime(60)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith(3)

    vi.useRealTimers()
  })
})
