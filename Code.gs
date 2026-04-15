function doGet() {
  const t = HtmlService.createTemplateFromFile('index');
  return t.evaluate()
    .setTitle('Schema Scraper Tool');
}

function pushSchemaDatatoSheet(sheetUrl, schemaData) {
  if (!sheetUrl) {
    throw new Error('Google Sheet URL is required.');
  }
  if (!schemaData || typeof schemaData !== 'object') {
    throw new Error('Schema data payload is required.');
  }

  const spreadsheet = SpreadsheetApp.openByUrl(sheetUrl);
  const sheet = spreadsheet.getSheetByName('Blog/Article');
  if (!sheet) {
    throw new Error('Tab "Blog/Article" was not found in the provided Google Sheet.');
  }

  const blogPosting = schemaData.blogPosting || {};
  const webPage = schemaData.webPage || {};
  const breadcrumbList = schemaData.breadcrumbList || {};
  const listItem = schemaData.listItem || {};
  const thing = schemaData.thing || {};
  const imageObjects = Array.isArray(schemaData.imageObjects) ? schemaData.imageObjects : [];

  const writeCell = (a1, value) => sheet.getRange(a1).setValue(value || '');

  // Blog Posting
  writeCell('B4', blogPosting.toolUri);
  writeCell('B5', blogPosting.url);
  writeCell('B6', blogPosting.name);
  writeCell('B7', blogPosting.author);
  writeCell('B8', blogPosting.dateModified);
  writeCell('B9', blogPosting.datePublished);
  writeCell('B10', blogPosting.description);
  writeCell('B11', blogPosting.headline);
  writeCell('B13', blogPosting.about);
  writeCell('B14', blogPosting.alternateName);
  writeCell('B15', blogPosting.articleSection);
  writeCell('B17', blogPosting.commentCount);
  writeCell('B18', blogPosting.creator);
  writeCell('B19', blogPosting.expires);
  writeCell('B20', blogPosting.inLanguage);
  writeCell('B21', blogPosting.isAccessibleForFree);
  writeCell('B22', blogPosting.isFamilyFriendly);
  writeCell('B24', blogPosting.keywords);
  writeCell('B25', blogPosting.publisher);
  writeCell('B26', blogPosting.timeRequired);
  writeCell('B29', blogPosting.wordCount);

  // Web Page
  writeCell('D4', webPage.toolUri);
  writeCell('D5', webPage.url);
  writeCell('D6', webPage.name);
  writeCell('D8', webPage.dateModified);
  writeCell('D9', webPage.datePublished);
  writeCell('D10', webPage.expires);
  writeCell('D12', webPage.inLanguage);
  writeCell('D13', webPage.isAccessibleForFree);
  writeCell('D14', webPage.isFamilyFriendly);
  writeCell('D16', webPage.mainEntityOfPage);
  writeCell('D17', webPage.publisher);

  // BreadcrumbList
  const positions = Array.isArray(breadcrumbList.positions) ? breadcrumbList.positions : [];
  for (let i = 0; i < 5; i += 1) {
    writeCell(`F${4 + i}`, positions[i] || '');
  }
  writeCell('F9', breadcrumbList.toolUri);
  writeCell('F11', breadcrumbList.itemListOrder);
  writeCell('F12', breadcrumbList.name);
  writeCell('F13', breadcrumbList.numberOfItems);
  writeCell('F15', breadcrumbList.url);

  // ListItem + Thing
  writeCell('F18', listItem.toolUri);
  writeCell('F19', listItem.name);
  writeCell('F21', listItem.position);
  writeCell('F22', listItem.previousItem);
  writeCell('F24', listItem.url);
  writeCell('F27', thing.name);
  writeCell('F28', thing.toolUri);

  // ImageObject rows (I:N, starting at row 4)
  sheet.getRange(4, 9, 200, 6).clearContent();
  if (imageObjects.length > 0) {
    sheet.getRange(4, 9, imageObjects.length, 6).setValues(imageObjects);
  }

  return 'Schema data was written to Blog/Article tab.';
}
