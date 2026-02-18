import soulsDownloadHandler from '../../souls/[id]/download.js';

export default async function handler(req, res) {
  return soulsDownloadHandler(req, res);
}
