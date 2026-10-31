/**
 * @fileoverview A link label that rolls up to its Japanese twin on hover or
 * keyboard focus (Films → 作品). The twin is decorative: screen readers keep
 * the English label.
 *
 * The parent link carries `group/flip`; the roll is a CSS transition on the
 * tokenised duration, the one motion the rules allow outside react-spring.
 */

export interface KanjiFlipProps {
  label: string;
  jp?: string;
}

const ROLL =
  "block transition-transform duration-[var(--duration-flip)] ease-entrance motion-reduce:transition-none";

export const KanjiFlip = ({ label, jp }: KanjiFlipProps) => {
  if (!jp) return <>{label}</>;
  return (
    <span className="relative inline-block overflow-hidden align-top">
      <span
        className={`${ROLL} group-hover/flip:-translate-y-full group-focus-visible/flip:-translate-y-full`}
      >
        {label}
      </span>
      <span
        aria-hidden="true"
        lang="ja"
        className={`${ROLL} absolute top-0 left-0 translate-y-full font-kanji whitespace-nowrap group-hover/flip:translate-y-0 group-focus-visible/flip:translate-y-0`}
      >
        {jp}
      </span>
    </span>
  );
};
