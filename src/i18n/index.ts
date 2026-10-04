import en from './en';
import { registerMessages } from '@huishouden/pwa-kit/i18n';

type ConnectorEn = typeof en;
declare module '@huishouden/pwa-kit/i18n' {
  interface AppMessages extends ConnectorEn {}
}

registerMessages(en, { es: () => import('./es'), nl: () => import('./nl') });

export { t } from '@huishouden/pwa-kit/i18n';
export type MessageKey = keyof ConnectorEn;
