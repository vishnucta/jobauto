// What the apply assistant reads on an employer's page: whether the
// application went through, whether a CAPTCHA stands in the way, and the
// buttons that lead to the form and send it. German and English, since
// both appear on German career pages.

const SUBMITTED =
  /vielen dank f(ü|ue)r (ihre|deine) bewerbung|danke f(ü|ue)r (ihre|deine) bewerbung|bewerbung (wurde|ist) (erfolgreich )?(gesendet|(ü|ue)bermittelt|eingegangen|abgeschickt|verschickt|versendet|eingereicht)|wir haben (ihre|deine) bewerbung erhalten|(ihre|deine) bewerbung ist (bei uns )?eingegangen|erfolgreich beworben|thank you for (your )?appl(ying|ication)|thanks for (your )?appl(ying|ication)|application (has been |was |is )?(submitted|received|sent|complete)|successfully (submitted|applied|sent)|we('ve| have) received your application|your application (has been|was) (received|submitted)/i;

const SUBMITTED_URL = /(danke|thank|thanks|confirmation|confirm|success|submitted|applied|bestaetigung|bestätigung|erfolg)/i;

/** Whether the page says the application went through: its text, or its address when the form has gone. */
export function looksSubmitted({ text, url, formGone }: { text: string; url: string; formGone: boolean }): boolean {
  if (SUBMITTED.test(text)) return true;
  return formGone && SUBMITTED_URL.test(url);
}

const CAPTCHA = /recaptcha|hcaptcha|turnstile|cf-challenge|friendlycaptcha|captcha/i;

/** Whether a CAPTCHA is on the page: the user has to answer it, and Send is never pressed for her. */
export function looksLikeCaptcha({ html, frameUrls }: { html: string; frameUrls: string[] }): boolean {
  if (frameUrls.some((frame) => /recaptcha|hcaptcha|turnstile|challenges\.cloudflare/i.test(frame))) return true;
  return CAPTCHA.test(html);
}

// A site's own check that it isn't talking to a bot (Cloudflare's "Just a moment…", and the like) answers an automated browser with a page that
// has no form on it. Its title is short and fixed, its text a few lines.
const BLOCKED_TITLE = /^(just a moment|nur einen moment|un instant|un momento|even geduld|attention required|access denied|zugriff verweigert|pardon our interruption|checking your browser)/i;
const BLOCKED_TEXT =
  /sicherheits(ü|ue)berpr(ü|ue)fung|security check|verify(ing)? (that )?you are (a )?human|are you a robot|ich bin kein roboter|schutz vor (b(ö|oe)swilligen )?bots|against (malicious )?bots|enable javascript and cookies to continue|\bray id\b/i;

/**
 * Whether the page is a site's bot check, not the page asked for. The assistant
 * doesn't try to get past one: the user's own browser does, and she carries on.
 * A long page is a real page, whatever words it uses.
 */
export function looksBlocked({ title, text }: { title: string; text: string }): boolean {
  return BLOCKED_TITLE.test(title.trim()) || (text.length < 3_000 && BLOCKED_TEXT.test(text));
}

/** Buttons and links that lead from a posting to its form, most specific first. */
export const APPLY_ENTRY_TEXTS: readonly RegExp[] = [
  /jetzt (online )?bewerben/i,
  /online bewerben/i,
  /zur (online-?)?bewerbung/i,
  /auf diese stelle bewerben/i,
  /^bewerben$/i,
  /apply (now|for this (job|position|role))/i,
  /^apply$/i,
];

/** "I'm interested": SmartRecruiters' way to its form, but on a job board such as XING it shares the profile with the recruiter. */
const INTERESTED_TEXTS: readonly RegExp[] = [/i'?m interested/i, /ich bin interessiert/i];

/** Buttons that send the form, most specific first; never "Weiter"/"Next". */
export const SUBMIT_TEXTS: readonly RegExp[] = [
  /bewerbung (jetzt )?(absenden|abschicken|senden|einreichen)/i,
  /jetzt bewerben/i,
  /submit (my )?application/i,
  /send (my )?application/i,
  /^(absenden|abschicken|senden|einreichen)$/i,
  /^bewerben$/i,
  /^(submit|send|apply)$/i,
];

/**
 * The buttons a run may click on its way to the form, and the names it
 * leaves alone there, since nothing it clicks on the way may send
 * anything. A job board goes without "I'm interested". Past the posting's
 * own page, a button named like Send is left to the user: a board's
 * quick-apply step words its Send button the way posting pages word the
 * way in ("Jetzt bewerben").
 */
export function entryButtons({ board, pastPosting }: { board: boolean; pastPosting: boolean }): { texts: readonly RegExp[]; except: readonly RegExp[] } {
  return { texts: board ? APPLY_ENTRY_TEXTS : [...APPLY_ENTRY_TEXTS, ...INTERESTED_TEXTS], except: pastPosting ? SUBMIT_TEXTS : [] };
}

/** Cookie banners' "accept" buttons, so they don't cover the form. */
export const COOKIE_ACCEPT_TEXTS: readonly RegExp[] = [
  /alle (cookies )?akzeptieren/i,
  /alle(s)? (annehmen|zulassen|erlauben)/i,
  /^akzeptieren$/i,
  /^zustimmen$/i,
  /^einverstanden$/i,
  /accept all( cookies)?/i,
  /allow all/i,
  /^(accept|agree|ok|okay|got it)$/i,
];

/** Known cookie-banner buttons, by selector. */
export const COOKIE_ACCEPT_SELECTORS: readonly string[] = [
  "#onetrust-accept-btn-handler",
  "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
  "#CybotCookiebotDialogBodyButtonAccept",
  "button[data-testid='uc-accept-all-button']",
  "#uc-btn-accept-banner",
  ".cc-btn.cc-allow",
  "#cookie-accept",
  "#cookieAccept",
  "button#didomi-notice-agree-button",
  "#BorlabsCookieBoxSaveAllButton",
  ".borlabs-cookie-preference-save-all",
];
