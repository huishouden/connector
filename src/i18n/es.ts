import type en from './en';

const es: Record<keyof typeof en, string> = {
  'consent.title': '¿Conectar {client} con Huishouden?',
  'consent.body': '{client} podrá ver y cambiar las cosas de tu hogar en Huishouden en tu nombre: el calendario, los pendientes, las listas de compras, las mascotas, la casa, las facturas y los contactos, y Salud para las personas que cuidas. Las reglas del hogar siguen decidiendo todo, igual que en las apps.',
  'consent.redirect': 'El acceso va a {host}.',
  'consent.loopback': 'Esto envía el acceso a una app en tu propia computadora. Continúa solo si acabas de empezar a conectar desde ella.',
  'consent.unverified': 'Esta app eligió su propio nombre; Huishouden no puede comprobarlo.',
  'consent.verified': 'Publicada por {domain}.',
  'consent.continue': 'Continuar con Google',
  'consent.cancel': 'Cancelar',
  'consent.revoke': 'Puedes desconectarlo cuando quieras desde el menú de la cuenta: Usar con tu asistente de IA.',
  'consent.error': 'Esta solicitud de conexión no se puede usar: {reason}. Vuelve a empezar desde tu asistente.',
  'consent.expired': 'Esta página caducó o se abrió en otro navegador. Vuelve a empezar desde tu asistente.',

  'quota.connection': 'Este asistente ya usó su parte de Huishouden por hoy. Se renueva a medianoche, hora del Pacífico; mientras tanto, las apps siguen funcionando.',
  'quota.connector': 'Los asistentes de IA ya usaron su parte de Huishouden por hoy. Se renueva a medianoche, hora del Pacífico; mientras tanto, las apps siguen funcionando.',
  'quota.project': 'Huishouden ya usó su asignación gratuita diaria y no puede leer nada hasta la medianoche, hora del Pacífico. Inténtalo de nuevo después.',
};

export default es;
