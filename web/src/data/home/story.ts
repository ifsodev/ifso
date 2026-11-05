/**
 * Content for the home story after the hero: blocks 2-10 of the Figma concept
 * (Get Layers → Templates | Diana → Concept 15, frames 03 → 10).
 *
 * Every background in the concept is a frame of one of the three sequences, so
 * stills are referenced from the sequence manifests rather than duplicated.
 */

import { autumnCity, type ChapterContent } from "@/data/home/intro";
import { offered } from "@/lib/ifso/features";
import {
  skylineSequence,
  studentSequence,
  windowSequence,
  type SequenceManifest,
} from "@/data/home/sequences";

export interface CaptionContent {
  headlineLines: string[];
  /** Body copy; each entry starts on a new line. */
  bodyLines: string[];
  chapter: ChapterContent;
}

/** One cloud cut-out, pre-blurred at two depths — see <CloudMeet>. */
export interface CloudCutout {
  /** Lightly blurred, for the cut-outs nearest the front. */
  soft: string;
  /** Heavily blurred, for the ones sitting further back. */
  deep: string;
}

export interface WipeContent {
  /** Accessible description of the transition shot. */
  label: string;
  /**
   * Opening frames of the incoming sequence. The transition scrubs them under
   * the clouds, so the shot is already moving by the time they part.
   */
  incomingFrames: string[];
  /** The same frames, portrait cut — see `SequenceManifest.portraitFrames`. */
  incomingPortraitFrames: string[];
  /** Share of the incoming sequence they cover, so its own scrub resumes there. */
  leadShare: number;
  /** Cut-outs for the curtain — see <CloudMeet>. */
  clouds: CloudCutout[];
  chapter: ChapterContent;
}

export interface CloudPassContent {
  label: string;
  /**
   * Opening frames of the incoming sequence. The transition scrubs them under
   * the clouds, so the shot is already moving by the time they part.
   */
  incomingFrames: string[];
  /** The same frames, portrait cut — see `SequenceManifest.portraitFrames`. */
  incomingPortraitFrames: string[];
  /** Share of the incoming sequence they cover, so its own scrub resumes there. */
  leadShare: number;
  /** Cut-outs for the curtain — see <CloudMeet>. */
  clouds: CloudCutout[];
  questionLines: string[];
  subtitle: string;
  outgoingChapter: ChapterContent;
  incomingChapter: ChapterContent;
}

export interface Film {
  title: string;
  /** "Short film · 7:40 · 2025" */
  meta: string;
  year: string;
  href: string;
  /** Two stills — one for each side of the ring the film appears on. */
  stills: [string, string];
}

export interface WorksContent {
  headlineLines: string[];
  films: Film[];
  cloud: string;
  cloudBank: string;
  chapter: ChapterContent;
  hint: string;
  watchLabel: string;
}

export interface FooterColumn {
  label: string;
  /**
   * `short` replaces `text` where the columns are narrow — on phones, or from
   * the landscape tablet down when `shortFrom` is "tablet".
   */
  lines: { text: string; short?: string; shortFrom?: "tablet"; href?: string }[];
}

export interface ContactContent {
  background: string;
  runningLine: string[];
  email: string;
  columns: FooterColumn[];
  tickerItems: string[];
}

const last = (frames: string[]) => frames[frames.length - 1];
const middle = (frames: string[]) => frames[Math.floor(frames.length / 2)];

const lookUp: ChapterContent = { kanji: "見上げる", translation: ["Look", "Up"] };
const toDraw: ChapterContent = { kanji: "描く", translation: ["To", "Draw"] };
const theWorks: ChapterContent = { kanji: "作品", translation: ["The", "Works"] };

const cloud = "/assets/home/cloud.png";
const cloudBank = "/assets/home/cloud-bank.png";
/** Cut-outs for the cloud curtain between sequences, one per band. */
const clouds: CloudCutout[] = [1, 2, 3, 4].map((n) => ({
  soft: `/assets/home/cloud-${n}-soft.webp`,
  deep: `/assets/home/cloud-${n}-deep.webp`,
}));

/**
 * Frames of the incoming sequence a transition plays before handing over.
 *
 * This is the number that decides how fast a transition *feels*. A scene's
 * scroll length is set by the copy it carries, but the picture under that
 * copy only advances by these frames — at 20 the cloud pass spent 143px of
 * scroll on every frame, seven times the sequences' own rate, and read as the
 * scroll being stuck rather than as a slow shot. The sequences give these
 * frames up: whatever a transition plays, the sequence after it resumes from
 * (`leadShare`), so the two rates trade against each other. 51 is where the
 * cloud pass and the window sequence after it come out level — the pair
 * spans 5624px and has 150 frames between them, so 37px each either way —
 * and it leaves every scene on the page inside 19-37px per frame.
 *
 * That 37 is the floor while a sequence is 150 frames long. Closing the last
 * of the gap to the sequences' own 19 means rendering more frames, not
 * moving this number.
 */
const LEAD_FRAMES = 51;
const lead = (sequence: SequenceManifest) => sequence.frames.slice(0, LEAD_FRAMES);
const leadPortrait = (sequence: SequenceManifest) =>
  sequence.portraitFrames.slice(0, LEAD_FRAMES);
const leadShare = (sequence: SequenceManifest) =>
  (LEAD_FRAMES - 1) / (sequence.frames.length - 1);

export const studioContent: CaptionContent = {
 headlineLines: ["Make a promise.", "Set a moment."],
 bodyLines: ["A date, a price, a result or an agreement. Choose what needs to happen and who it is for."], chapter: autumnCity,
};
export const wipeContent: WipeContent = {
 label: "Clouds drift over the city and part to reveal the city skyline", incomingFrames: lead(studentSequence), incomingPortraitFrames: leadPortrait(studentSequence), leadShare: leadShare(studentSequence), clouds, chapter: lookUp,
};
export const whatWeMakeContent: CaptionContent = {
 headlineLines: ["One link.", "A clear condition."], bodyLines: ["Share a private claim link.", "Your recipient can claim with a passkey, no wallet needed."], chapter: lookUp,
};
export const cloudPassContent: CloudPassContent = {
 label: "Clouds rise over the skyline and reveal the city", incomingFrames: lead(windowSequence), incomingPortraitFrames: leadPortrait(windowSequence), leadShare: leadShare(windowSequence), clouds,
 questionLines: ["What are you", "waiting for?"], subtitle: "When the moment arrives, money moves.", outgoingChapter: lookUp, incomingChapter: toDraw,
};
export const processContent: CaptionContent = {
 headlineLines: ["Set. Share.", "Let it unfold."], bodyLines: ["Choose the terms and sign.", "Your recipient claims the link.", "The condition decides what happens next."], chapter: toDraw,
};
// The match film is shown only when NEXT_PUBLIC_SPORTS_ENABLED=1; the numbers stay in sequence either way.
const works = (films: Film[]): Film[] => offered(films, (f) => f.href.split("#")[1] ?? "").map((f, i) => ({ ...f, year: String(i + 1).padStart(2, "0") }));
export const worksContent: WorksContent = {
 headlineLines: ["Choose your", "moment"], films: works([
 {title:"A date arrives",meta:"TIME · CHAIN TIME",year:"01",href:"/conditions#date",stills:[middle(skylineSequence.frames),middle(windowSequence.frames)]},
 {title:"A price moves",meta:"PRICE · CHAINLINK FEEDS",year:"02",href:"/conditions#price",stills:[last(windowSequence.frames),skylineSequence.frames[0]]},
 {title:"Both say yes",meta:"APPROVAL · AGREEMENT",year:"03",href:"/conditions#approval",stills:[studentSequence.frames[0],last(skylineSequence.frames)]},
 {title:"A referee decides",meta:"REFEREE · RELEASE OR RETURN",year:"04",href:"/conditions#referee",stills:[last(studentSequence.frames),middle(studentSequence.frames)]},
 {title:"A match ends",meta:"RESULT · BONDED RESOLVER",year:"05",href:"/conditions#match",stills:[windowSequence.frames[0],middle(skylineSequence.frames)]},
 {title:"A question resolves",meta:"MARKET · FINAL RESOLUTION",year:"06",href:"/conditions#market",stills:[middle(windowSequence.frames),studentSequence.frames[0]]},
 ]), cloud, cloudBank, chapter: theWorks, hint: "Scroll to explore", watchLabel: "explore condition",
};
export const contactContent: ContactContent = {
 background: skylineSequence.frames[0], runningLine: ["If this, then so.", "Money with a moment."], email: "",
 columns: [
 {label:"Explore",lines:[{text:"How it works",href:"/how-it-works"},{text:"Conditions",href:"/conditions"}]},
 {label:"Details",lines:[{text:"Pricing",href:"/pricing"},{text:"Technology",href:"/technology"}]},
 {label:"Legal",lines:[{text:"Privacy",href:"/privacy-policy"},{text:"Terms & risks",href:"/terms"}]},
 {label:"IFSO",lines:[{text:"Built on Robinhood Chain"},{text:"Back to top ↑",href:"#top"}]},
 ], tickerItems:["IFSO — conditional payments", "USDG", "Every payment has an expiry", "If this, then so"],
};
