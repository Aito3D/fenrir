/** The SMS relay on the operator's own Mac (scripts/sms_relay_mac.py). The page
 *  calls it directly, so the server never needs the Mac's address, and only the
 *  Mac running it can send.
 *  shortcut: fixed port matching the script's default; make it a setting if the relay ever moves. */
const SMS_RELAY_URL = 'http://localhost:8765/send';

/** unreachable: no relay on this machine (or the browser blocked the call),
 *  nothing sent. maybe: Messages timed out, the SMS may have gone. failed:
 *  the relay or Messages refused, nothing sent. */
export class SmsRelayError extends Error {
  readonly outcome: 'unreachable' | 'maybe' | 'failed';
  constructor(outcome: SmsRelayError['outcome']) {
    super(outcome);
    this.outcome = outcome;
  }
}

export async function sendThroughRelay(phone: string, text: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(SMS_RELAY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, text }),
    });
  } catch {
    throw new SmsRelayError('unreachable');
  }
  if (res.status === 504) throw new SmsRelayError('maybe');
  if (!res.ok) throw new SmsRelayError('failed');
}

// GSM 03.38: the basic set costs one unit, the extension two. Any other character switches the
// whole SMS to UCS-2, 70 characters per part.
const GSM_BASIC = new Set(
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà",
);
const GSM_EXTENSION = new Set('^{}\\[~]|€');

/** What a text costs: characters as the network counts them, SMS parts, and whether it stays in GSM-7. */
export function smsLength(text: string): { chars: number; parts: number; gsm: boolean } {
  let units = 0;
  for (const ch of text) {
    if (GSM_BASIC.has(ch)) units += 1;
    else if (GSM_EXTENSION.has(ch)) units += 2;
    else {
      const chars = Array.from(text).length;
      return { chars, parts: chars <= 70 ? 1 : Math.ceil(chars / 67), gsm: false };
    }
  }
  return { chars: units, parts: units <= 160 ? 1 : Math.ceil(units / 153), gsm: true };
}
