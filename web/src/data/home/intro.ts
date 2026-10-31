/**
 * Content for the home intro: the preloader and the hero (block 1).
 *
 * Copy and layout data come from the Figma concept (Get Layers → Templates |
 * Diana → Concept 15, frames "01 — Intro · loading", "01b — Intro → hero" and
 * "02 — Hero"). Components stay content-agnostic and take all of this as props.
 */

import { skylineSequence, studentSequence, windowSequence } from "@/data/home/sequences";

export interface NavLink {
  label: string;
  href: string;
  /** Japanese twin the label rolls up to on hover. */
  jp?: string;
}

export interface PreloaderContent {
  /** Wordmark next to the 層 mark while loading. */
  brandName: string;
  studioLine: string;
  statusLine: string;
  /** Hero frame the screen opens onto — the first frame of the sequence under it. */
  heroFrame: string;
  /** Frames warmed up before the screen opens, so the scrub starts smooth. */
  preloadFrames: string[];
  /** The same frames, portrait cut — warmed instead on a portrait phone. */
  preloadPortraitFrames: string[];
  /** The loading picture, drawn line by line. */
  asciiArt: string[];
}

export interface HeaderContent {
  brandName: string;
  navColumns: NavLink[][];
  cta: NavLink;
  sceneTime: string;
  scenePlace: string;
  sceneShot: string;
  /** Portrait-tablet menu button, closed and open. */
  menuOpen: string;
  menuClose: string;
  email: string;
  /** Burger menu: a label per nav column, and the socials line. */
  menuGroups: string[];
  socials: string;
}

export interface ChapterContent {
  kanji: string;
  translation: string[];
}

export interface HeroContent {
  headlineLines: string[];
  intro: string[];
  chapter: ChapterContent;
  tickerItems: string[];
}

/** First-screen frames fetched during loading — about a second of scrub. */
const PRELOAD_FRAME_COUNT = 150;

export const preloaderContent: PreloaderContent = {
  brandName: "IFSO",
  studioLine: "Conditional payments on Robinhood Chain",
  statusLine: "Preparing the moment",
  heroFrame: skylineSequence.frames[0],
  preloadFrames: [...skylineSequence.frames.slice(0, PRELOAD_FRAME_COUNT), ...studentSequence.frames, ...windowSequence.frames, ...[1,2,3,4].flatMap(n => [`/assets/home/cloud-${n}-soft.webp`, `/assets/home/cloud-${n}-deep.webp`]), "/assets/home/cloud.png", "/assets/home/cloud-bank.png", "/ifso-seal-transparent.png"],
  preloadPortraitFrames: [...skylineSequence.portraitFrames.slice(0, PRELOAD_FRAME_COUNT), ...studentSequence.portraitFrames, ...windowSequence.portraitFrames, ...[1,2,3,4].flatMap(n => [`/assets/home/cloud-${n}-soft.webp`, `/assets/home/cloud-${n}-deep.webp`]), "/assets/home/cloud.png", "/assets/home/cloud-bank.png", "/ifso-seal-transparent.png", ...[skylineSequence.frames[0], skylineSequence.frames[75], skylineSequence.frames[149], studentSequence.frames[0], studentSequence.frames[75], studentSequence.frames[149], windowSequence.frames[0], windowSequence.frames[75], windowSequence.frames[149]]],
  asciiArt: [
    "=+===--------:::---++*#%%%%%%@%%%###***********+=--=+++*####***++====+*%@@@@@@@@%%%%%###*++==+++++++#%@@%%%%%@%%%%%#**+=",
    "=+===------::::::::::-=+++**##%@%%#***##***++++++===+*****++===#%%%%@@@@@@@@@@%%@@@@@%%###**+===+*#%%%@@@@@@@@@%%##**+=-",
    "===----::::::::...:-:...:::--=+*########*+++++++++*******++==+@@@@@@@@@@@@@@%#*+++*%@@@@@@@@%*=-=+*##%@@@@@@@@@%%#***+=-",
    "++==---+*++*%%##*#@@@%#+:.:::::-+++*##***++++=====+++++++**+*@@@@@@@@@@@@%%#*+++====*#%%%#%%@@#=-=*#%@@@@@@@@@%####***+=",
    "===--+%@@@@@@@@@@@@@@@@@#-.....::--=+*+++++======-------#@@@@@@@@@@@@@@%%##*++====--===+==--=+++**#%@@@@@@@@%%%###%%#*+=",
    "-=-=*%@@@@@@@@@@@%%%##*#%%%##+-----==++++++**====*+===*#@@@@@@@@@@@@@@@@@%#*++==---------::::::=+#%@@@@@@@@@%%%####*++=-",
    "=+++*%@@@@@@@@@@@@#**++++*#@@@@@@#++=+++++===--=#%#*#@@@@@@@@@@@@@@@@@@%%##+++===----::::::::::...:-+%%@@@@%%%%#**+===-:",
    "----+%@@@@@@@@@%%#+++++++==+*%@@@@@%*++++++++++##%%%%%%####%@@@@@@@@@%##**++====-------:::::::.......-*%%##****++==----:",
    ":=+*%@@@@@%####*++*%@@@@@%#+=++*####%#+=+++++*###**##%@@@@@@@@@@@@@@%#**++=====---------::::::......:-***#*%%###*+=----:",
    "*@@@@@@@%##****+**%@@@%####+=====++++++==++++++=+*%@@@@@@@@@@@@@@@@@%#*++==--------:::::::..........:=+*#%%#%%%%%#*=-::.",
    "%@@@@%%##***+***#%@@%#*++============+##+====+*#%@@@@@@@@@@@@@@@@@@@@@@@@%*=------:::::::..........:----===--==--===-:..",
    "%@@%%##**++++*###%@%*++====---------==+##**++%@@@@@@@@@@@@@%%%@@@@@@@@@@@@@%*=---::::::::.........::::::.........::::...",
    "%@%##**##%%%%##****++====--------------=+*%@@@@@@@@@@@@@%%%##########%@%##%@@@*+---::..............:::..................",
    "%@%#**#@@@@@@@%%*+=====------:::::::-=---=*@@@@@@@@@@@@%####*****+++++++++++**#@@@@%**=.................................",
    "#%%###########%%#*==-------:::::=***%@@#+++#@@@@@@@@@%%###***+++++++========-=+%@@@@@@@*:............................-+*",
    "*#####*++===========----:::::.-%@@@@@@@@@@@%@@@@@@@@%%###***+++++++======----=*%%%@@@@@%#*+-::.......................#@%",
    "+****++==-----------:::::...-*%@@@@@@@@@@@@@@@@@@@@%%###*****+++++=======----=+****######%%#+-:...::.................#@%",
    "=++++==---::::::::::::......-#%%@@@@@@@@@@@@@@@@@@@%@@@@#***+++===-----=-------====+++++%@@@@@#**%@@#+-:............-#@%",
    "-=====--::::::::............:*##%@%%##%%%%%@@@%@@@@@@@@@@#**+===-----------------+#%@@@@@@@@@@@@@@@@@@@@+............*@%",
    ":-----::::...................-*##*********####%@@@@@@@%#**++==-----------------=%@@@@@@@@@@@@@@@@@@@@@@%%*=+*++==----*@%",
    "::::::::.......................=+++++++++++**#%@@@@@@@@%+====-----------:::::-#@@@@@@@@@@@@@@@@@@%%%######%%%%#%%%@%@%%#",
    ".:.............................:=========+++*###%%#%%%%%%%%*+=-------:::::::::#@@@@@@@@@@@@@@@@@%%#****++++**#%%%%%%@@%#",
    "......................:--:--==----------=====+++**++++**@@%#*=-----::=*#@%*+=--#@@@@@@%@@@@%%####***+++====++*#%%%@@@@@#",
    "...................+#%@@@@@@@@@%+-----------============+++==-------+@@@@@@@@%#%@@@@@%@@@@@@@@%*++++++=======+#%@@@@@@@%",
    "...............-*#@@@@@@@@@@@@@@@+.:::::::-------------------------=*@@@@@@@@@@@@@@@%@@@@@@@%%%*+++++=======+*%@@@@@@@@%",
    "=*+=---.......=%@@@@@@@@@@@@@@@@%*-=++-:::::::::::::::::::::::::---=+#@%%####%@@@@@%%#***##*+++====----===+*#%%%%%%%%%%%",
    "%@@@%@%+:....-@@@@@@@@@%%%%%%%%%%@@@@@@#-::::::::::.:::.:::::::::----=+**+++*#%@@%%%@@%*+++====----------=+***++++*###%#",
    "%@@@@@@%=-::=%@@@@@@@@%%########%%%@@@@@%-::::::::-=-:...........::----===+==++***%@@%%*+=====-------------===--==+***#*",
    "@@@@@@@@%@@@@@@@@@@@%%##***********##%%%*:..:=***#@@@%+............::---------====+##**++=---------::::::::::::--==+++++",
    "%@@@@@@@@@@@@@@@@@@%###%%%*++++++++***##+==+%@@@@@@@@@@=............:::-----------====+*+---:::::::::-::::::::::-======-",
    "%@%@@@@@@@@@@@@@@%%%@@@@@@@*+=++++++++*#%@@@@@@@@@@@@%%#-............:::---------=+=------::=++-::-*%@%%#+-::::::::----:",
    "#%%%%%@@@@@@@@@%%%@@@@@@@@@@#+=======++*#%@@@@@@@@@@%##*#%+--==--::.::-::----------:::::::=#@@@@#*%@@@@@@%#=:.......:::.",
    "*###%@@@@@@@@%%%#%@@@@@@@%%%%*=---=====++*#%@@@@@@@%#***%%%#*+-:......:::::::::---:::::--+@@@@@@@@@@@@@%%###+-..........",
    "+**##%%%%%%%##**#%@@%###*****+=---------==+**######***++*####=............::::::::::::-*%@@@@@@@@@@@@@%%#*++=-..........",
  ],
};

export const headerContent: HeaderContent = {
  brandName: "IFSO",
  navColumns: [
    [{ label: "How it works", href: "/how-it-works" }, { label: "Conditions", href: "/conditions" }, { label: "Pricing", href: "/pricing" }, { label: "Dashboard", href: "/dashboard" }],
    [{ label: "Technology", href: "/technology" }, { label: "Questions", href: "/how-it-works#questions" }],
    [{ label: "Privacy", href: "/privacy-policy" }, { label: "Terms", href: "/terms" }, { label: "Risks", href: "/risks" }],
  ],
  cta: { label: "Create payment", href: "/dashboard?create=1" },
  sceneTime: "--:--:-- EST", scenePlace: "Robinhood Chain", sceneShot: "IF / SO",
  menuOpen: "Menu +", menuClose: "Close ×", email: "", menuGroups: ["Explore", "Learn", "Legal"], socials: "Money that moves when something happens",
};
export const autumnCity: ChapterContent = { kanji: "約束", translation: ["A", "Promise"] };
export const heroContent: HeroContent = {
  headlineLines: ["Money that moves", "when something happens."],
  intro: ["Send USDG with a condition.", "If it happens, the money moves. If not, it comes back."],
  chapter: autumnCity,
  tickerItems: ["IFSO — If this, then so", "Conditional payments", "USDG", "Robinhood Chain", "Every payment has an expiry"],
};
