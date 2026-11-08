import { canon } from './canon'
import type { TokClass } from './types'

export class Intern {
  private nextId = 1
  private canonToId = new Map<string, number>()
  private surfaceToId = new Map<string, number>()
  public forms = new Map<number, Map<string, number>>()
  public idToCanon = new Map<number, string>()
  public idToCls = new Map<number, TokClass>()

  intern(word: string, cls: TokClass): { id: number; cls: TokClass } {
    const surfKey = `${cls}:\0${word}`
    const hit = this.surfaceToId.get(surfKey)
    if (hit !== undefined) {
      this.forms.get(hit)!.set(word, (this.forms.get(hit)!.get(word) || 0) + 1)
      return { id: hit, cls: this.idToCls.get(hit)! }
    }
    const key = canon(word, cls)
    let id = this.canonToId.get(key)
    if (id === undefined) {
      id = this.nextId++
      this.canonToId.set(key, id)
      this.idToCanon.set(id, key)
      this.idToCls.set(id, cls)
      this.forms.set(id, new Map())
    }
    this.surfaceToId.set(surfKey, id)

    const formMap = this.forms.get(id)!
    formMap.set(word, (formMap.get(word) || 0) + 1)

    return { id, cls: this.idToCls.get(id)! }
  }

  getCanon(id: number): string | undefined {
    return this.idToCanon.get(id)
  }

  getCls(id: number): TokClass | undefined {
    return this.idToCls.get(id)
  }
}
