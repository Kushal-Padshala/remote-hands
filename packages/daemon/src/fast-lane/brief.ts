/**
 * What the pilot may use from the user's own request: values to type (verbatim) and whether the
 * user handed over the choices ("complete this survey for me"). Everything here is the user's text,
 * so nothing a web page says can end up in it.
 */
export interface DerivedBrief {
  /** Guidance for subjective choices, present only when the user delegated them. */
  brief?: string;
  /** Named values the pilot may type; only the names are shown to the model. */
  facts: Record<string, string>;
  /** Close calls on answers (not on Submit or Send) may proceed with the best pick. */
  discretion: boolean;
}

const MAX_SCAN = 4000;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/;
const PHONE = /(?<![\w/.])\+?\d[\d ().-]{6,18}\d(?![\w/.])/;
const NAME = /\bmy name is ([\p{L}][\p{L}'.-]*(?: [\p{L}][\p{L}'.-]*){0,3})/iu;
const PASSWORD = /\bpassword\s*(?:is|:|=)?\s*(\S+)/i;
const SEARCH = /\bsearch(?:\s+for)?\s+["“']?([^"”'\n]{2,80}?)["”']?(?=\s+(?:on|in|at|and|then)\b|[.!?]?\s*$)/i;
const QUOTED = /["“]([^"”\n]{3,200})["”]/g;

const DELEGATING_TOPIC = /\b(survey|questionnaire|quiz|poll)\b/i;
const DELEGATING_ASK = /\b(answer|complete|fill|finish|do)\b/i;
const DELEGATING_PHRASE = /\b(whatever|as best you can|best possible|you (?:choose|decide|pick)|your choice|seems best)\b/i;

const GUIDANCE =
  'Answer on the user\'s behalf; when unsure choose the most reasonable middle answer. For "select all that apply" tick one or two sensible items. For a ranking, keep the suggested order. Skip optional free-text questions.';

export function deriveBrief(query: string): DerivedBrief {
  const text = query.slice(0, MAX_SCAN);
  const facts: Record<string, string> = {};

  const email = EMAIL.exec(text)?.[0];
  if (email) facts.email = email;
  const phone = PHONE.exec(text)?.[0];
  if (phone && !/^\d{1,3}(?:\.\d+){2,}$/.test(phone)) facts.phone = phone.trim();
  const name = NAME.exec(text)?.[1];
  if (name) facts.name = name;
  const password = PASSWORD.exec(text)?.[1];
  if (password && !/^(?:saved|stored|manager|here)$/i.test(password)) facts.password = password;

  const quoted: string[] = [];
  for (const m of text.matchAll(QUOTED)) {
    const value = m[1]!.trim();
    if (value.length >= 3 && !quoted.includes(value)) quoted.push(value);
    if (quoted.length >= 3) break;
  }
  quoted.forEach((value, i) => {
    facts[i === 0 ? 'quoted_text' : `quoted_text_${i + 1}`] = value;
  });

  const search = SEARCH.exec(text)?.[1]?.trim();
  if (search) facts.search_query = search;

  const discretion = (DELEGATING_TOPIC.test(text) && DELEGATING_ASK.test(text)) || (DELEGATING_PHRASE.test(text) && DELEGATING_ASK.test(text));
  return discretion ? { brief: `The user asked: "${query.trim().slice(0, 300)}". ${GUIDANCE}`, facts, discretion: true } : { facts, discretion: false };
}
