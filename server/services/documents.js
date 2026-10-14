import { Pdf } from '../pdf.js';
import { pdfLogo } from '../lib/logo.js';
import { config } from '../config.js';
import { formatDate, monthShort } from '../../shared/format.js';

const C = {
  ink: '#13203F',
  ink2: '#37425E',
  muted: '#5B6680',
  primary: '#0B3F91',
  onPrimary: '#C9D8F2',
  gold: '#D4A537',
  goldText: '#FFD66B',
  border: '#DDE3EE',
  bg: '#F4F6FB',
  ok: '#2F7D4F',
  okBg: '#DDEFE3',
  amber: '#B7791F',
};
const LEFT = 48;
const RIGHT = 595.28 - 48;

function header(pdf, subtitle) {
  pdf.rect(0, 0, pdf.width, 108, { fill: C.primary });
  pdf.rect(0, 108, pdf.width, 4, { fill: C.gold });
  const logo = pdfLogo();
  const textLeft = logo ? LEFT + 84 : LEFT;
  if (logo) pdf.image(logo, LEFT - 4, 18, 76, 76);
  pdf.text(config.school.name, textLeft, 46, { size: 17, bold: true, color: '#FFFFFF' });
  pdf.text(config.school.shortAddress, textLeft, 63, { size: 9, color: C.onPrimary });
  pdf.text(subtitle, textLeft, 86, { size: 12, bold: true, color: C.goldText });
}

function footer(pdf, text) {
  pdf.line(LEFT, 790, RIGHT, 790);
  pdf.text(text, LEFT, 808, { size: 9, color: C.muted });
}

function detailRows(pdf, rows, y) {
  const colWidth = (RIGHT - LEFT) / 2;
  rows.forEach((pair, i) => {
    const rowY = y + Math.floor(i / 2) * 44;
    const x = LEFT + (i % 2) * colWidth;
    pdf.text(pair[0], x, rowY, { size: 9, color: C.muted });
    pdf.text(pair[1], x, rowY + 16, { size: 12, bold: true });
  });
  return y + Math.ceil(rows.length / 2) * 44;
}

export function reportCardPdf(student, annual) {
  const pdf = new Pdf({ title: `Report card – ${student.name}` });
  header(pdf, `Progress report · ${annual.yearLabel}`);

  let y = detailRows(
    pdf,
    [
      ['Student', student.name],
      ['Class', `${student.classLabel} · Roll no. ${student.rollNo}`],
    ],
    150,
  );

  // Summary tiles
  y += 8;
  const tiles = [
    ['Average marks', annual.avgAll === null ? '–' : `${annual.avgAll}%`],
    ['Attendance', annual.attAll === null ? '–' : `${annual.attAll}%`],
    ['Activities', String(annual.activities)],
  ];
  const gap = 12;
  const tileW = (RIGHT - LEFT - gap * 2) / 3;
  tiles.forEach(([label, value], i) => {
    const x = LEFT + i * (tileW + gap);
    pdf.rect(x, y, tileW, 62, { fill: C.bg });
    pdf.text(value, x + 14, y + 30, { size: 20, bold: true });
    pdf.text(label, x + 14, y + 48, { size: 9, color: C.muted });
  });
  y += 90;

  // Marks table: one column per published month, then the average and trend.
  const reports = annual.reports;
  pdf.text('Marks by month (out of 100)', LEFT, y, { size: 13, bold: true });
  y += 14;
  const subjectW = 130;
  const tailW = 110;
  const monthW = reports.length ? (RIGHT - LEFT - subjectW - tailW) / reports.length : 0;
  const colX = (i) => LEFT + subjectW + monthW * i + monthW / 2;

  pdf.rect(LEFT, y, RIGHT - LEFT, 26, { fill: C.bg });
  pdf.text('Subject', LEFT + 10, y + 17, { size: 9, bold: true, color: C.muted });
  reports.forEach((r, i) => pdf.text(monthShort(r.month), colX(i), y + 17, { size: 9, bold: true, color: C.muted, align: 'center' }));
  pdf.text('Avg', RIGHT - 70, y + 17, { size: 9, bold: true, color: C.muted, align: 'right' });
  pdf.text('Trend', RIGHT - 10, y + 17, { size: 9, bold: true, color: C.muted, align: 'right' });
  y += 26;

  const rowOf = (label, values, avg, trend, trendColor) => {
    pdf.text(label, LEFT + 10, y + 19, { size: 11 });
    values.forEach((v, i) => pdf.text(v, colX(i), y + 19, { size: 11, align: 'center' }));
    pdf.text(avg, RIGHT - 70, y + 19, { size: 11, bold: true, align: 'right' });
    pdf.text(trend, RIGHT - 10, y + 19, { size: 10, bold: true, color: trendColor, align: 'right' });
    y += 28;
    pdf.line(LEFT, y, RIGHT, y);
  };

  for (const subject of annual.subjects) {
    const values = reports.map((r) => {
      const score = r.marks.find((m) => m.subject === subject.name)?.score;
      return score === null || score === undefined ? '–' : String(score);
    });
    const trend = subject.trend === null ? '' : `${subject.trend > 0 ? '+' : ''}${subject.trend}`;
    rowOf(subject.name, values, subject.avg === null ? '–' : String(subject.avg), trend, subject.trend < 0 ? C.amber : C.ok);
  }
  rowOf(
    'Attendance',
    reports.map((r) => (r.attPct === null ? '–' : `${r.attPct}%`)),
    annual.attAll === null ? '–' : `${annual.attAll}%`,
    '',
    C.muted,
  );

  if (annual.highlights.length) {
    y += 28;
    pdf.text('Highlights', LEFT, y, { size: 13, bold: true });
    y = pdf.paragraph(annual.highlights.join(' · '), LEFT, y + 20, RIGHT - LEFT, { size: 11, color: C.ink2 });
  }

  if (annual.latestRemark) {
    y += 14;
    pdf.text(`Teacher remarks (${annual.latestRemark.month})`, LEFT, y, { size: 13, bold: true });
    y = pdf.paragraph(annual.latestRemark.text, LEFT, y + 20, RIGHT - LEFT, { size: 11, color: C.ink2 });
    pdf.text(`— Class teacher, ${student.classLabel}`, LEFT, y + 4, { size: 10, color: C.muted });
  }

  if (!reports.length) {
    pdf.text('No progress reports have been published yet.', LEFT, y + 24, { size: 11, color: C.muted });
  }

  footer(pdf, `Generated on ${formatDate(new Date().toISOString())}. Includes reports published by the school so far.`);
  return pdf.toBuffer();
}
