/**
 * An invented household for the emulator: every role, a non-member, and Health with a carer and a
 * non-carer. Names, emails and records are made up. Times are fixed around NOW, a Tuesday morning in
 * New York, so answers are the same on every machine.
 */

export const PROJECT = 'demo-huishouden-connector';
export const ZONE = 'America/New_York';
/** 2031-01-07 10:00 in New York. */
export const NOW = Date.UTC(2031, 0, 7, 15, 0);
export const TODAY = '2031-01-07';
const HOUR = 3600_000;
const DAY = 24 * HOUR;
/** An absolute time for a New York wall clock on 2031-01-07 (UTC-5). */
export const ny = (hhmm: string, day = TODAY) => Date.parse(`${day}T${hhmm}:00-05:00`);

export const ALICE = 'alice@example.com'; // admin (created the household)
export const BOB = 'bob@example.com'; // member, cares for Nan
export const CAROL = 'carol@example.com'; // member, not a carer
export const HELEN = 'helen@example.com'; // helper, cares for Nan
export const KIM = 'kim@example.com'; // kid
export const MALLORY = 'mallory@example.com'; // in another household only
export const PEOPLE = [ALICE, BOB, CAROL, HELEN, KIM, MALLORY];

const H = 'households/h1';
const URL = 'https://huishouden-staging.web.app';

/** Document path → data, written with the emulator's owner token (rules bypassed). */
export function householdDocs(): Record<string, Record<string, unknown>> {
  return {
    [H]: { name: 'Maple Street', members: [ALICE, BOB, CAROL, HELEN, KIM], joined: [ALICE, BOB, CAROL, HELEN, KIM], roles: { [HELEN]: 'helper', [KIM]: 'kid' }, createdAt: 1, currency: 'USD' },
    'households/h2': { name: 'Elsewhere', members: [MALLORY], joined: [MALLORY], createdAt: 1 },
    [`${H}/profiles/${ALICE}`]: { name: 'Alice Example', lang: 'en', timeZone: ZONE, updatedAt: 1 },
    [`${H}/profiles/${BOB}`]: { name: 'Bob Example', lang: 'nl', timeZone: ZONE, updatedAt: 1 },
    [`${H}/profiles/${HELEN}`]: { name: 'Helen Example', timeZone: ZONE, updatedAt: 1 },
    [`${H}/profiles/${CAROL}`]: { name: 'Carol Example', timeZone: ZONE, updatedAt: 1 },
    [`${H}/profiles/${KIM}`]: { name: 'Kim Example', timeZone: ZONE, updatedAt: 1 },

    // Groceries and Tasks
    [`${H}/lists/groceries`]: { name: 'Groceries', description: '', icon: 'grocery', color: 'green', sortOrder: 0, createdAt: 1 },
    [`${H}/lists/costco`]: { name: 'Costco & Bulk', description: '', icon: 'bulk', color: 'blue', sortOrder: 2, createdAt: 1 },
    [`${H}/lists/chores`]: { name: 'Chores & Notes', description: '', icon: 'chores', color: 'stone', sortOrder: 4, createdAt: 1 },
    [`${H}/items/milk`]: { listId: 'groceries', name: 'Milk', category: 'Dairy & Eggs', quantity: '1', notes: '', addedBy: 'Alice', by: ALICE, completed: false, urgency: 'Standard', position: 1, createdAt: NOW - DAY, updatedAt: NOW - DAY, completedAt: null },
    [`${H}/items/t1`]: { listId: 'chores', name: 'Clean the gutters', category: 'Chores & Tasks', quantity: '1', notes: '', addedBy: 'Bob', by: BOB, completed: false, urgency: 'Standard', position: 2, createdAt: NOW - 40 * DAY, updatedAt: NOW - 40 * DAY, completedAt: null },

    // The shared agenda and to-do list, as the apps publish them
    [`${H}/agenda/pet_appointment_a1_1`]: { app: 'pet', ref: 'appointment:a1', kind: 'appointment', title: 'Vet: annual checkup', start: ny('14:00'), allDay: false, detail: 'Biscuit', url: `${URL}/pet/?tab=appointments`, who: 'Biscuit', private: false, updatedAt: 1, by: ALICE },
    [`${H}/agenda/bills_bill_b1_1`]: { app: 'bills', ref: 'bill:b1', kind: 'bill', title: 'Electric bill', start: Date.parse('2031-01-10T00:00:00-05:00'), allDay: true, url: `${URL}/bills/`, status: 'upcoming', private: true, updatedAt: 1, by: ALICE },
    [`${H}/todos/tasks:item:t1`]: {
      app: 'tasks', ref: 'item:t1', title: 'Clean the gutters', createdAt: NOW - 40 * DAY, url: `${URL}/tasks/?list=chores&item=t1`, status: 'open', private: false, owner: BOB,
      done: { label: 'Done', ops: [{ col: 'items', id: 't1', data: { completed: true, completedAt: '$now', updatedAt: '$now' }, merge: true }], roles: ['admin', 'member', 'helper', 'kid'] },
      cancel: { label: 'Cancel', ops: [{ col: 'items', id: 't1', data: { completed: true, completedAt: '$now', cancelledAt: '$now', cancelledBy: '$me', updatedAt: '$now' }, merge: true }], roles: ['admin', 'member'], owner: true },
      updatedAt: 1, by: BOB,
    },
    [`${H}/todos/bills:bill:b1`]: {
      app: 'bills', ref: 'bill:b1', title: 'Pay Electric', detail: '$84.20', createdAt: NOW - 2 * DAY, due: ny('00:00', '2031-01-10'), url: `${URL}/bills/`, status: 'open', private: true,
      done: { label: 'Mark paid', ops: [{ col: 'bills', id: 'b1', data: { status: 'paid', paidAt: '$now', paidBy: '$me', paidVia: 'member', updatedAt: '$now' }, merge: true }], roles: ['admin', 'member'] },
      updatedAt: 1, by: ALICE,
    },

    // Bills
    [`${H}/bills/b1`]: { schema: 'bill/v1', source: 'manual', kind: 'electric', label: 'Electric', due: '2031-01-10', amountDue: { amount: '84.20', currency: 'USD' }, status: 'due', autopay: null, createdAt: 1, createdBy: ALICE, updatedAt: 1 },

    // Pet
    [`${H}/petProfiles/p1`]: { name: 'Biscuit', species: 'dog', weightUnit: 'kg', createdAt: 1, by: ALICE },
    [`${H}/petMeals/p1-am`]: { petId: 'p1', name: 'Breakfast', time: '08:00', portion: '1 cup', createdAt: 1, by: ALICE },
    [`${H}/petMeals/p1-pm`]: { petId: 'p1', name: 'Dinner', time: '18:00', portion: '1 cup', createdAt: 1, by: ALICE },
    [`${H}/petFeedings/f1`]: { petId: 'p1', mealId: 'p1-am', at: ny('08:10'), by: HELEN, createdAt: ny('08:10') },
    [`${H}/petReminders/r1`]: { petId: 'p1', kind: 'heartworm', title: 'Heartworm chew', every: 1, unit: 'month', due: TODAY, createdAt: 1, by: ALICE },
    [`${H}/petMedCourses/c1`]: { petId: 'p1', name: 'Ear drops', dose: '2 drops', timesPerDay: 2, times: ['08:00', '20:00'], startDate: '2031-01-05', days: 7, withFood: false, createdAt: 1, by: ALICE },

    // Home
    [`${H}/homeTasks/j1`]: { title: 'Replace HVAC filter', category: 'hvac', schedule: { kind: 'after-done', every: 3, unit: 'month' }, due: '2031-01-05', lastDone: '2030-10-05', createdAt: 1, by: ALICE },
    [`${H}/homeEvents/e1`]: { title: 'Trash pickup', kind: 'trash', rule: { freq: 'week', every: 1, start: '2031-01-02', days: [4] }, time: '07:00', createdAt: 1, by: ALICE },

    // Car
    [`${H}/carVehicles/v1`]: { name: 'Blue wagon', make: 'Example', createdAt: 1, by: ALICE },

    // Contacts
    [`${H}/contacts/doc1`]: { name: 'Dr. Example', role: 'Doctor', phone: '555-0100', apps: ['health'], private: false, createdAt: 1, by: ALICE },
    [`${H}/contacts/pharm1`]: { name: 'Corner Pharmacy', role: 'Pharmacy', phone: '555-0199', address: '1 Example Way', apps: ['health'], private: false, createdAt: 1, by: ALICE },
    [`${H}/contacts/secret1`]: { name: 'Family lawyer', role: 'Lawyer', apps: ['home'], private: true, createdAt: 1, by: ALICE },

    // Health: Nan, cared for by Bob (member) and Helen (helper)
    [`${H}/healthPeople/nan`]: { name: 'Nan', birthDate: '1950-03-02', carers: [BOB, HELEN], readers: [BOB, HELEN], allergies: 'Penicillin', notes: 'Prefers tea with medicines', createdAt: 1, by: ALICE },
    [`${H}/healthPeople/nan/meds/m1`]: {
      personId: 'nan', name: 'Examplamine', strength: '10 mg', dose: '1 tablet', doseAmount: 1, doseUnit: 'tablet', asNeeded: false, times: ['08:00', '20:00'], everyDays: 1, withFood: true,
      startDate: '2031-01-01', prescriberId: 'doc1', pharmacyId: 'pharm1', refills: 2, supply: 12, supplyAt: NOW - 5 * DAY, escalateMinutes: 30, remind: true, notes: 'Take with a full glass of water', createdAt: 1, by: ALICE,
    },
    [`${H}/healthPeople/nan/meds/m2`]: { personId: 'nan', name: 'Paracetamol', strength: '500 mg', dose: '1 tablet', asNeeded: true, times: [], minHours: 4, maxPerDay: 4, startDate: '2031-01-01', escalateMinutes: 0, remind: false, createdAt: 1, by: ALICE },
    [`${H}/healthPeople/nan/doses/m1_2031-01-07T0800`]: { personId: 'nan', medId: 'm1', slot: '2031-01-07T08:00', at: ny('08:05'), status: 'given', by: HELEN, createdAt: ny('08:05') },
    [`${H}/healthPeople/nan/doses/m1_2031-01-06T2000`]: { personId: 'nan', medId: 'm1', slot: '2031-01-06T20:00', at: ny('20:10', '2031-01-06'), status: 'given', by: BOB, createdAt: ny('20:10', '2031-01-06') },
  };
}
