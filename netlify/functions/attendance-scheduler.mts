import { importNovemberRoster } from '../../db/operations-assistant.js';
import { automateAttendance } from '../../db/attendance-automation.js';

export default async () => {
  try{await importNovemberRoster()}catch{console.error('roster.import.failed')}
  await automateAttendance();
};

export const config = { schedule: '* * * * *' };
