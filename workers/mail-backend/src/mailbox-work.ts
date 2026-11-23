// Delivery and alarm work must use the same order. An alarm that sees an empty
// journal must not disarm while a delivery which relied on it is still in flight.
export class MailboxWork {
  private tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const work = this.tail.then(operation);
    this.tail = work.then(() => {}, () => {});
    return work;
  }
}
