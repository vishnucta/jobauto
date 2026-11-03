// The languages documents can be written in (SET-7) and what the renderer
// needs from them: a BCP 47 tag for `lang` (which also picks the right
// Chinese, Japanese or Korean glyphs) and the writing direction.

export type TextDirection = "ltr" | "rtl";

type LanguageInfo = { name: string; tag: string; dir?: TextDirection };

/** The built-in "Write documents in" list, in the prototype's order (`DOC_LANGS`). */
export const DOCUMENT_LANGUAGES: readonly LanguageInfo[] = [
  { name: "English", tag: "en" },
  { name: "Dutch", tag: "nl" },
  { name: "German", tag: "de" },
  { name: "French", tag: "fr" },
  { name: "Spanish", tag: "es" },
  { name: "Italian", tag: "it" },
  { name: "Portuguese", tag: "pt" },
  { name: "Polish", tag: "pl" },
  { name: "Swedish", tag: "sv" },
  { name: "Danish", tag: "da" },
  { name: "Norwegian", tag: "no" },
  { name: "Finnish", tag: "fi" },
  { name: "Czech", tag: "cs" },
  { name: "Greek", tag: "el" },
  { name: "Turkish", tag: "tr" },
  { name: "Arabic", tag: "ar", dir: "rtl" },
  { name: "Persian", tag: "fa", dir: "rtl" },
  { name: "Hindi", tag: "hi" },
  { name: "Chinese (Simplified)", tag: "zh-Hans" },
  { name: "Japanese", tag: "ja" },
  { name: "Korean", tag: "ko" },
];

/** Languages people may add with "Other language…" that are written right to left. */
const OTHER_RIGHT_TO_LEFT: readonly LanguageInfo[] = [
  { name: "Farsi", tag: "fa", dir: "rtl" },
  { name: "Hebrew", tag: "he", dir: "rtl" },
  { name: "Urdu", tag: "ur", dir: "rtl" },
  { name: "Pashto", tag: "ps", dir: "rtl" },
  { name: "Dari", tag: "prs", dir: "rtl" },
  { name: "Kurdish (Sorani)", tag: "ckb", dir: "rtl" },
  { name: "Sindhi", tag: "sd", dir: "rtl" },
  { name: "Uyghur", tag: "ug", dir: "rtl" },
  { name: "Yiddish", tag: "yi", dir: "rtl" },
  { name: "Dhivehi", tag: "dv", dir: "rtl" },
];

// Letters of scripts written right to left: Hebrew, Arabic, Syriac, Thaana, N'Ko…
const RIGHT_TO_LEFT = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/u;
const RIGHT_TO_LEFT_LETTERS = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/gu;
const LETTERS = /\p{L}/gu;

const count = (text: string, pattern: RegExp) => text.match(pattern)?.length ?? 0;

/** Whether text contains right-to-left letters. */
export function hasRightToLeft(text: string): boolean {
  return RIGHT_TO_LEFT.test(text);
}

/** The direction most of the text's letters are written in. */
export function detectDirection(text: string): TextDirection {
  const rightToLeft = count(text, RIGHT_TO_LEFT_LETTERS);
  return rightToLeft > count(text, LETTERS) - rightToLeft ? "rtl" : "ltr";
}

/**
 * A language tag when most of the text is in a script only one of the
 * built-in languages uses, so a Chinese company name in an English resume
 * doesn't make it Chinese.
 */
function detectTag(text: string): string | undefined {
  const letters = count(text, LETTERS);
  const han = count(text, /\p{Script=Han}/gu);
  const kana = count(text, /[\p{Script=Hiragana}\p{Script=Katakana}]/gu);
  const hangul = count(text, /\p{Script=Hangul}/gu);
  const most = (n: number) => n > letters / 2;
  // Japanese mixes kana with kanji, and Korean can use hanja.
  if (hangul > 0 && most(hangul + han)) return "ko";
  if (kana > 0 && most(kana + han)) return "ja";
  if (most(han)) return "zh-Hans";
  if (most(count(text, /\p{Script=Devanagari}/gu))) return "hi";
  if (most(count(text, /\p{Script=Greek}/gu))) return "el";
  return undefined;
}

/** A language by its name, from the list or one of the right-to-left ones it knows ("Farsi"). */
export function knownLanguage(language: string | null | undefined): LanguageInfo | undefined {
  const name = language?.trim().toLowerCase();
  return name ? [...DOCUMENT_LANGUAGES, ...OTHER_RIGHT_TO_LEFT].find((entry) => entry.name.toLowerCase() === name) : undefined;
}

/**
 * The `lang` and `dir` for a document written in `language` (a name from
 * the list, or one added with "Other language…"). Without a language, or
 * for one it doesn't know, it looks at the text instead, as for the base
 * resume, which is in whatever language the profile is.
 */
export function documentLanguage(
  language: string | null | undefined,
  sample: string,
): { lang?: string; dir: TextDirection } {
  const known = knownLanguage(language);
  if (known) return { lang: known.tag, dir: known.dir ?? "ltr" };
  return { lang: detectTag(sample), dir: detectDirection(sample) };
}

// Function words of the Latin-script languages in the list, for telling
// which of them a tailored resume's text is in (the resume check): a text
// in one language is full of its own little words and has few of another's.
const STOPWORDS: Record<string, string> = {
  en: "the and of to in a is that for with as on was at by an be this from are or it which have has were not but their its into over than also our they been where while",
  nl: "de het een en van in is dat op te met voor zijn die niet aan er ook als bij door om uit naar over dan maar nog wordt werd worden heeft hebben ik we jaar meer tot onder tussen waar deze dit hun mijn",
  de: "der die das und in zu den von mit ist des dem nicht ein eine als auch es an auf für sich im bei aus nach einer einem über um wurde wurden werden hat haben ich wir sowie durch oder zur zum dass einen bis unter mehr jahre jahren",
  fr: "le la les de des du et en un une à est que qui dans pour pas sur par au aux avec ce cette ces il elle ils nous vous sont plus ou ne se son sa ses leur mais été ans dont comme où lors ainsi",
  es: "el la los las de del y en un una que es por para con se no su sus al lo como más pero años fue han ha sobre entre desde hasta también donde este esta son o ser muy sin durante",
  it: "il lo la i gli le di del della dei delle e ed in un una che è per con non su da al alla come più anche sono ha hanno nel nella degli anni tra fra questo questa dove sia suo sua dal ma o",
  pt: "o a os as de do da dos das e em um uma que é para com não se por no na nos nas ao mais como foi são ou anos pelo pela sobre entre também onde este esta ser muito sem durante tem",
  pl: "i w z na do nie się jest że to oraz dla od po przez jak ale przy lub jako są był była było były które który która tym ich jego jej pod nad lat roku latach bardzo także również aby czy tego tej",
  sv: "och i att det som en ett av är för med på till har de den inte om var så kan från vid eller men också under efter över mellan år sedan hos genom samt denna detta dessa vi jag mer nya",
  da: "og i at det som en et af er for med på til har de den ikke om var så kan fra ved eller men også under efter over mellem år siden hos gennem samt denne dette disse vi jeg mere nye hvor hvad nogle noget meget blev været bliver",
  no: "og i at det som en et av er for med på til har de den ikke om var så kan fra ved eller men også under etter over mellom år siden hos gjennom samt denne dette disse vi jeg mer nye hvor hva noen noe mye ble vært blir",
  fi: "ja on ei että oli se hän tämä joka kanssa myös mutta kun niin vuotta sekä tai ovat olen olin ollut vuoden jossa jonka kuin nyt vain voi mukaan sen sitä tässä josta ole jo",
  cs: "a v ve na se je s z že do pro o k jako jsem jsme byl byla bylo byly který která které od po při ale nebo také let roku během kde než tak již aby i u za ze až mezi",
  tr: "ve bir bu ile için da de olarak olan gibi daha çok en her sonra kadar ya ama ancak ise yıl yıllık tarafından üzerinde içinde arasında göre hem ne mi mı ben biz şu ki olduğu ederek yaparak",
};
const STOPWORD_SETS = Object.entries(STOPWORDS).map(([tag, words]) => ({ tag, words: new Set(words.split(" ")) }));

/** Fewer words than a summary has say nothing: a headline or a skills line is in no language. */
const MIN_TOKENS = 20;

/**
 * The name of the language a text is written in ("German"), for the
 * Latin-script languages in the list, or undefined when there's too little
 * text or no clear winner, as in a resume half in English and half in German.
 */
export function detectLanguageName(text: string): string | undefined {
  const tokens = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  if (tokens.length < MIN_TOKENS) return undefined;
  const scored = STOPWORD_SETS.map((entry) => ({ ...entry, hits: tokens.filter((token) => entry.words.has(token)).length })).sort((a, b) => b.hits - a.hits);
  const [winner, runnerUp] = scored;
  if (winner.hits < tokens.length * 0.03) return undefined;
  // Words both share (Dutch and German "die", Danish and Norwegian "og") say nothing about which of the two it is, so the margin is judged on the rest.
  const own = (a: (typeof scored)[number], b: (typeof scored)[number]) => tokens.filter((token) => a.words.has(token) && !b.words.has(token)).length;
  const lead = own(winner, runnerUp);
  if (lead === 0 || lead < 1.5 * own(runnerUp, winner)) return undefined;
  return DOCUMENT_LANGUAGES.find((entry) => entry.tag === winner.tag)?.name;
}
