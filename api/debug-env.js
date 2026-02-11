export default function handler(req, res) {
  res.json({
    hasServiceKey: !!process.env.SERVICE_WALLET_KEY,
    serviceKeyLength: process.env.SERVICE_WALLET_KEY ? process.env.SERVICE_WALLET_KEY.length : 0,
    hasSellerAddress: !!process.env.SELLER_ADDRESS,
    sellerAddress: process.env.SELLER_ADDRESS
  });
}
