/**
 * SEOzar Audit Tool — Lead Capture Webhook
 *
 * SETUP STEPS:
 * 1. Create a new Google Sheet. Add headers in row 1: Email | Website | Score | Date
 * 2. In the Sheet, go to Extensions > Apps Script.
 * 3. Delete any starter code and paste this entire file in.
 * 4. Click "Deploy" > "New deployment" > Select type "Web app".
 *    - Execute as: Me
 *    - Who has access: Anyone
 * 5. Click Deploy, authorize the permissions when prompted.
 * 6. Copy the "Web app URL" it gives you.
 * 7. Paste that URL into index.html, replacing SHEET_WEBHOOK_URL's placeholder value.
 */

function doPost(e) {
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
    const data = JSON.parse(e.postData.contents);

    sheet.appendRow([
      data.email || '',
      data.website || '',
      data.score || '',
      data.date || new Date().toISOString()
    ]);

    return ContentService
      .createTextOutput(JSON.stringify({ result: 'success' }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ result: 'error', message: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
