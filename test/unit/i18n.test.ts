import { describe, expect, test } from 'bun:test';
import { messageArgs } from '@huishouden/pwa-kit/i18n';
import en from '../../src/i18n/en';
import es from '../../src/i18n/es';
import nl from '../../src/i18n/nl';

describe('catalogues', () => {
  for (const [lang, cat] of [['es', es], ['nl', nl]] as const) {
    test(`${lang} has every key with the same placeholders`, () => {
      expect(Object.keys(cat).sort()).toEqual(Object.keys(en).sort());
      for (const key of Object.keys(en) as (keyof typeof en)[]) expect([key, messageArgs(cat[key]).sort()]).toEqual([key, messageArgs(en[key]).sort()]);
    });
  }
});
