const targetLength = 220;
const longSentenceLength = 360;
const sentences = new Intl.Segmenter(undefined, { granularity: 'sentence' });

/** Split at natural boundaries without cutting words, links, or emoji sequences. */
export function splitTextMessages(text: string): string[] {
  if (text.length <= targetLength) return [text];
  const result: string[] = [];
  for (const paragraph of text.trim().split(/\n\s*\n/)) {
    const units = [...sentences.segment(paragraph)].flatMap(({ segment }) => {
      if (segment.trim().length <= longSentenceLength) return [segment.trim()];
      const wrapped: string[] = [];
      let part = '';
      for (const word of segment.trim().split(/\s+/)) {
        if (part && part.length + word.length + 1 > targetLength) { wrapped.push(part); part = ''; }
        part += `${part ? ' ' : ''}${word}`;
      }
      if (part) wrapped.push(part);
      return wrapped;
    });
    let bubble = '';
    for (const unit of units) {
      if (bubble && bubble.length + unit.length + 1 > targetLength) { result.push(bubble); bubble = ''; }
      bubble += `${bubble ? ' ' : ''}${unit}`;
    }
    if (bubble) result.push(bubble);
  }
  // Keep a tiny acknowledgment attached to the thought that follows it.
  for (let i = 0; i < result.length - 1; i++) {
    if (result[i]!.length < 40 && result[i]!.length + result[i + 1]!.length + 1 <= longSentenceLength) {
      result.splice(i, 2, `${result[i]} ${result[i + 1]}`);
    }
  }
  return result.length ? result : [text];
}
