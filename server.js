const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');

dotenv.config();

const app = express();

const PORT = process.env.PORT || 10000;

/*
============================================================
VYNIX CHECKOUT BACKEND
============================================================

This server will eventually handle:

1. COD orders
2. Razorpay prepaid payments
3. Razorpay payment verification
4. Shopify order creation
5. Shopify customer association
6. Shipping calculation
7. Discount handling
8. Order-success response

IMPORTANT:
- Secrets are NOT stored in this file.
- Secrets will be added to Render Environment Variables.
============================================================
*/


/*
============================================================
MIDDLEWARE
============================================================
*/

app.use(
  cors({
    origin: [
      'https://www.vynix.co.in',
      'https://vynix.co.in'
    ],
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type']
  })
);

app.use(
  express.json({
    limit: '1mb'
  })
);


/*
============================================================
BASIC SERVER INFO
============================================================
*/

app.get('/', function (req, res) {
  res.json({
    success: true,
    message: 'VYNIX Checkout Backend is running.'
  });
});


/*
============================================================
HEALTH CHECK
============================================================

Render can use this endpoint to confirm that the server
is alive.

It does NOT expose any secret values.
============================================================
*/

app.get('/health', function (req, res) {
  res.json({
    success: true,
    service: 'VYNIX Checkout Backend',
    status: 'online',
    shopifyConfigured: Boolean(
      process.env.SHOPIFY_STORE_DOMAIN &&
      process.env.SHOPIFY_CLIENT_ID &&
      process.env.SHOPIFY_CLIENT_SECRET
    ),
    razorpayConfigured: Boolean(
      process.env.RAZORPAY_KEY_ID &&
      process.env.RAZORPAY_KEY_SECRET
    )
  });
});


/*
============================================================
SHOPIFY ACCESS TOKEN
============================================================

Shopify's Client Credentials Grant gives the backend an
Admin API access token.

The token is temporary, so we cache it in memory and obtain
a new one when needed.

The Client Secret NEVER goes to the browser.
============================================================
*/

let shopifyToken = null;
let shopifyTokenExpiresAt = 0;


async function getShopifyAccessToken() {

  const now = Date.now();

  /*
  Reuse the existing token if it still has more than
  one minute remaining.
  */

  if (
    shopifyToken &&
    now < shopifyTokenExpiresAt - 60 * 1000
  ) {
    return shopifyToken;
  }


  const shopifyDomain =
    process.env.SHOPIFY_STORE_DOMAIN;

  const clientId =
    process.env.SHOPIFY_CLIENT_ID;

  const clientSecret =
    process.env.SHOPIFY_CLIENT_SECRET;


  if (
    !shopifyDomain ||
    !clientId ||
    !clientSecret
  ) {
    throw new Error(
      'Shopify environment variables are not configured.'
    );
  }


  const tokenResponse = await fetch(
    `https://${shopifyDomain}/admin/oauth/access_token`,
    {
      method: 'POST',

      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },

      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'client_credentials'
      })
    }
  );


  const tokenData =
    await tokenResponse.json();


  if (!tokenResponse.ok) {

    console.error(
      'Shopify token request failed:',
      tokenData
    );

    throw new Error(
      'Unable to authenticate with Shopify.'
    );
  }


  shopifyToken =
    tokenData.access_token;


  /*
  Shopify returns expires_in.
  We keep a small safety margin.
  */

  const expiresInSeconds =
    Number(tokenData.expires_in || 86399);

  shopifyTokenExpiresAt =
    Date.now() +
    (expiresInSeconds * 1000);


  return shopifyToken;
}


/*
============================================================
SHOPIFY GRAPHQL HELPER
============================================================
*/

async function shopifyGraphQL(query, variables = {}) {

  const token =
    await getShopifyAccessToken();


  const shopifyDomain =
    process.env.SHOPIFY_STORE_DOMAIN;


  const response = await fetch(
    `https://${shopifyDomain}/admin/api/2026-07/graphql.json`,
    {
      method: 'POST',

      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token
      },

      body: JSON.stringify({
        query,
        variables
      })
    }
  );


  const data =
    await response.json();


  if (!response.ok) {

    console.error(
      'Shopify API HTTP error:',
      data
    );

    throw new Error(
      'Shopify API request failed.'
    );
  }


  if (data.errors) {

    console.error(
      'Shopify GraphQL errors:',
      data.errors
    );

    throw new Error(
      'Shopify GraphQL request failed.'
    );
  }


  return data;
}


/*
============================================================
SHOPIFY CONNECTION TEST
============================================================

Temporary development endpoint.

We will use this to make sure Render can securely
communicate with Shopify before creating real orders.
============================================================
*/

app.get(
  '/api/test/shopify',
  async function (req, res) {

    try {

      const query = `
        query {
          shop {
            name
            myshopifyDomain
            currencyCode
          }
        }
      `;


      const result =
        await shopifyGraphQL(query);


      res.json({
        success: true,
        shop: result.data.shop
      });

    } catch (error) {

      console.error(
        'Shopify connection test error:',
        error
      );

      res.status(500).json({
        success: false,
        message: 'Shopify connection failed.'
      });
    }
  }
);


/*
============================================================
CHECKOUT ROUTES
============================================================

These are intentionally not connected to real orders yet.

We will add them after the backend foundation and
credentials are configured and tested.

COD:
POST /api/checkout/cod

PREPAID:
POST /api/checkout/prepaid/create

PAYMENT VERIFICATION:
POST /api/checkout/prepaid/verify
============================================================
*/


app.post(
  '/api/checkout/cod',
  function (req, res) {

    res.status(501).json({
      success: false,
      message: 'COD checkout is not connected yet.'
    });

  }
);


app.post(
  '/api/checkout/prepaid/create',
  function (req, res) {

    res.status(501).json({
      success: false,
      message: 'Razorpay checkout is not connected yet.'
    });

  }
);


app.post(
  '/api/checkout/prepaid/verify',
  function (req, res) {

    res.status(501).json({
      success: false,
      message: 'Payment verification is not connected yet.'
    });

  }
);


/*
============================================================
GLOBAL ERROR HANDLER
============================================================
*/

app.use(
  function (err, req, res, next) {

    console.error(
      'VYNIX backend error:',
      err
    );

    res.status(500).json({
      success: false,
      message: 'Internal server error.'
    });

  }
);


/*
============================================================
START SERVER
============================================================
*/

app.listen(
  PORT,
  function () {

    console.log(
      `VYNIX Checkout Backend running on port ${PORT}`
    );

  }
);
