// Class structure shared by the server and the browser apps.

export const GRADES = [
  'Nursery',
  'LKG',
  'UKG',
  'Class 1',
  'Class 2',
  'Class 3',
  'Class 4',
  'Class 5',
  'Class 6',
  'Class 7',
  'Class 8',
  'Class 9',
  'Class 10',
  'Class 11',
  'Class 12',
];

const isNumbered = (grade) => grade.startsWith('Class ');
const gradeNumber = (grade) => grade.replace('Class ', '');

// Short name of a section, as used on registers: "6-B", "Nursery-A".
export function sectionName(grade, section) {
  return `${isNumbered(grade) ? gradeNumber(grade) : grade}-${section}`;
}

// Full name for sentences and receipts: "Class 6-B", "Nursery-A".
export function classLabel(grade, section) {
  return isNumbered(grade) ? `Class ${gradeNumber(grade)}-${section}` : `${grade}-${section}`;
}

export function sortOrder(grade, section) {
  const index = GRADES.indexOf(grade);
  return (index < 0 ? 99 : index) * 100 + (section.toUpperCase().charCodeAt(0) - 64);
}

// Reads older class names such as "6-B" or "Nursery-A".
export function parseClassName(name) {
  const match = /^(.*?)[-\s]([A-Z])$/i.exec(String(name).trim());
  const base = match ? match[1] : String(name).trim();
  const section = match ? match[2].toUpperCase() : 'A';
  const grade = /^\d+$/.test(base) ? `Class ${Number(base)}` : GRADES.find((g) => g.toLowerCase() === base.toLowerCase()) ?? base;
  return { grade, section };
}
