export class Queue<T> {
  private readonly items: T[] = [];

  push(value: T): void {
    this.items.push(value);
  }

  values(): T[] {
    return [...this.items];
  }
}
