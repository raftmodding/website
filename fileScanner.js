'use strict';
var fs = require('fs');
var path = require('path');
var databaseCredentials = JSON.parse(fs.readFileSync('database.json'));
var VirusTotalApi = require('virustotal-api');
var virusTotal = new VirusTotalApi(databaseCredentials.virusTotalKey);

// request queue for VirusTotal
// max 4 requests per minute --> works smoother with 1 per 15sec
var virusTotalQueue = require('throttled-queue')(1, 15 * 1000);

// ORM for file-scans table
var FileScan = require('./models/fileScan');

// setTimeout as a promise - https://stackoverflow.com/q/39538473
function delay(delayInMs, value) {
  return new Promise(resolve => {
    setTimeout(resolve.bind(null, value), delayInMs);
  });
}

/**
 * Enqueues a file scan for the buffered file.
 * @param buffer the buffer of the file to scan
 * @param fileName the original file name
 * @param fileUrl the url to the file
 */
function scanFile(buffer, fileName, fileUrl) {
  FileScan.create({ fileUrl: fileUrl })
    .then(scan => {
      console.log('Saved scan: ' + scan);
    })
    .catch(err => {
      console.error('Error while creating file scan db entry: ', err);
    });

  // enqueue actual file scan
  virusTotalQueue(() => {
    console.log(`Submitting file ${fileUrl} to VirusTotal...`);
    virusTotal.fileScan(buffer, fileName)
      .then(result => {
        var scanId = result.scan_id;
        console.log(`Scan result of file ${fileName} (${fileUrl}) using ` +
                    'VirusTotal:', result);
        // save scan id to db
        FileScan.update({ scanId: scanId }, { where: { fileUrl: fileUrl } })
          .catch(err => {
            console.error(`Could not save scan id (${scanId}) for file ` +
                            `${fileName} (${fileUrl}): `, err);
          });
        return delay(60 * 1000, scanId);
      }).then(resourceId => {
        enqueueReportCheck(resourceId, fileName, fileUrl);
      }).catch(err => {
        console.error(`Scanning file ${fileName} (${fileUrl}) using ` +
                    'VirusTotal failed:', err);
      });
  });
}
/**
 * Enqueues a check for the resource report.
 * @param scanId the resource id / sha256 hash of the scanned file.
 * @param fileName the original file name
 * @param fileUrl the url to the file
 */
function enqueueReportCheck(scanId, fileName, fileUrl) {
  virusTotalQueue(() => {
    console.log(`Checking VirusTotal file report for file ${fileUrl}...`);
    virusTotal.fileReport(scanId)
      .then(report => {
        if (report.response_code !== 1) {
          console.log(`VirusTotal report for file ${fileUrl} is not yet ` +
                        ' ready, trying again in a minute...');
          return delay(60 * 1000, scanId).then(scanId => {
            enqueueReportCheck(scanId, fileName, fileUrl);
          });
        } else {
          delete report.scans;
          // save scan report to db
          FileScan.update({scanResult: report}, {where: {fileUrl: fileUrl}})
            .catch(err => {
              console.error(`Could not save scan report for file ${fileName} ` +
                                `(${fileUrl}): `, err);
            });
          if (report.positives > 0) {
            console.log(`VirusTotal found a virus in ${fileName} (${fileUrl}):`,
              report);
          } else {
            console.log(`VirusTotal didn't find any virus in ${fileName} ` +
                            `(${fileUrl}).`);
          }
        }
      }).catch(err => {
        console.error(`Scanning file ${fileName} (${fileUrl}) using ` +
                    'VirusTotal failed:', err);
      });
  });
}

FileScan.findAll()
  .then(fileScans => {
    var numRescans = 0;
    for (var i = 0; i < fileScans.length; i++) {
      if (!fileScans[i].scanId) {
        var fileName = fileScans[i].fileUrl
          .substr(fileScans[i].fileUrl.lastIndexOf('/') + 1);
        if (fileScans[i].fileUrl.startsWith('/')) {
          scanFile(fs.readFileSync(path.join('public', fileScans[i].fileUrl)),
            fileName, fileScans[i].fileUrl);
        } else {
          console.error('There is an unresolved file scan entry for ' +
            fileScans[i].fileUrl + ' in the file scans table, but external ' +
              'files can\'t be scanned!');
        }
        // start file scan
        numRescans++;
      } else if (!fileScans[i].scanResult) {
        enqueueReportCheck(fileScans[i].scanId, fileName, fileScans[i].fileUrl);
        numRescans++;
      }
    }
    if (numRescans > 0) {
      console.log(`Resuming ${numRescans} file scans...`);
    }
  }).catch(err => {
    console.error('Error while resuming unfinished file scans:', err);
  });

module.exports = {
  FileScan: FileScan,
  scanFile: scanFile,
  enqueueReportCheck: enqueueReportCheck,
};
