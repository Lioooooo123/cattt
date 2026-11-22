const neverRelay = /(?:别|不要|勿|不能|不许|不准|禁止)\s*(?:(?:把.{0,30}?)?(?:转告|告诉|透露|转达|转发|公开)|(?:跟|和|对|让|给).{1,32}?(?:说|讲|知道|看))|(?:don't|do not|never)\s+(?:tell|share|forward)/iu;

export function forbidsRelay(text: string): boolean {
  return neverRelay.test(text.normalize("NFKC"));
}

/** Only an explicit command in the member's persisted original can approve a relay or urgency. */
export function readRelayIntent(text: string) {
  if (forbidsRelay(text)) {
    return undefined;
  }
  const match = /^帮我(紧急)?转告[：:]\s*([^\r\n]+)$/u.exec(text.trim());
  const content = match?.[2]?.trim();
  if (!content) {
    return undefined;
  }
  return { urgent: match?.[1] !== undefined, content };
}
