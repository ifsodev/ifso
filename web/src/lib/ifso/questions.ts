import type { ParseQuestion, QuestionOption } from "./api";

/** Replaces the first case-insensitive occurrence of `from`; the whole text is kept when `from` is not found. */
export function replaceCI(text: string, from: string, to: string): string {
  const i = text.toLowerCase().indexOf(from.toLowerCase());
  return i < 0 ? text : text.slice(0, i) + to + text.slice(i + from.length);
}

/** Picking an option means: run `parse` again on the option's full text, or on the text with one part replaced. */
export function applyOption(currentText: string, option: QuestionOption): string {
  if (option.text) return option.text;
  if (option.replace) return replaceCI(currentText, option.replace[0], option.replace[1]);
  return currentText;
}

/** `build` is never called while the parser still has a question to ask. */
export const needsAnswers = (q: ParseQuestion[] | undefined) => !!q && q.length > 0;
