const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const Razorpay = require('razorpay');

dotenv.config();

const app = express();

const PORT = process.env.PORT || 10000;


/*
============================================================
VYNIX CHECKOUT BACKEND
============================================================

CURRENTLY ENABLED:

1. Render / Node.js server
2. Shopify Admin API connection
3. Shopify Client Credentials authentication
4. Razorpay connection
5. Razorpay TEST order creation

NOT YET ENABLED:

- Real COD order creation
- Real Shopify order creation
- Prepaid checkout
- Payment verification
- Discount processing
- Cart clearing
- Wishlist redirect

IMPORTANT:
Secrets are stored in Render Environment Variables.
They are NOT stored in this file.
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
RAZORPAY
============================================================

The Key ID and Key Secret are loaded from Render.

We will use these credentials to create Razorpay
TEST orders.

Do NOT put the actual secret inside this file.
============================================================
*/

let razorpay = null;


if (
  process.env.RAZORPAY_KEY_ID &&
  process.env.RAZORPAY_KEY_SECRET
) {

  razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
  });

}


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

Shopify's Client Credentials Grant gives the backend
an Admin API access token.

The token is temporary, so we cache it in memory and
request a new one when necessary.

The Client Secret NEVER goes to the browser.
============================================================
*/

let shopifyToken = null;
let shopifyTokenExpiresAt = 0;


async function getShopifyAccessToken() {

  const now = Date.now();


  /*
  Reuse the current token if it has more than one minute
  remaining.
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


  const expiresInSeconds =
    Number(
      tokenData.expires_in || 86399
    );


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

async function shopifyGraphQL(
  query,
  variables = {}
) {

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
RAZORPAY TEST ORDER
============================================================

THIS IS A TEST ENDPOINT.

It creates a Razorpay order only.

It does NOT:

- Charge a customer
- Open Razorpay Checkout
- Create a Shopify order
- Create a VYNIX order
- Modify the Shopify cart

The amount is supplied in RUPEES by the request.

Example:

POST /api/test/razorpay

{
  "amount": 100
}

The backend converts ₹100 into 10000 paise.

============================================================
*/

app.post(
  '/api/test/razorpay',
  async function (req, res) {

    try {

      /*
      Make sure Razorpay credentials exist.
      */

      if (!razorpay) {

        return res.status(500).json({

          success: false,

          message:
            'Razorpay environment variables are not configured.'

        });

      }


      /*
      Read amount from request.
      */

      const amount =
        Number(req.body.amount);


      /*
      Validate amount.
      */

      if (
        !Number.isFinite(amount) ||
        amount <= 0
      ) {

        return res.status(400).json({

          success: false,

          message:
            'Please provide a valid amount greater than 0.'

        });

      }


      /*
      Convert rupees to paise.

      Example:

      ₹100
      ↓
      10000 paise
      */

      const amountInPaise =
        Math.round(amount * 100);


      /*
      Create Razorpay TEST order.
      */

      const razorpayOrder =
        await razorpay.orders.create({

          amount: amountInPaise,

          currency: 'INR',

          receipt:
            `vynix_test_${Date.now()}`,

          notes: {

            purpose:
              'VYNIX Razorpay test order'

          }

        });


      /*
      Return only safe information to the browser.
      */

      return res.json({

        success: true,

        test: true,

        message:
          'Razorpay test order created successfully.',

        order: {

          id:
            razorpayOrder.id,

          amount:
            razorpayOrder.amount,

          currency:
            razorpayOrder.currency,

          status:
            razorpayOrder.status

        }

      });


    } catch (error) {

      console.error(
        'Razorpay test order error:',
        error
      );


      return res.status(500).json({

        success: false,

        message:
          'Unable to create Razorpay test order.'

      });

    }

  }
);


/*
============================================================
CHECKOUT ROUTES
============================================================

These will be implemented later.

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

      message:
        'COD checkout is not connected yet.'

    });

  }
);


app.post(
  '/api/checkout/prepaid/create',
  function (req, res) {

    res.status(501).json({

      success: false,

      message:
        'Razorpay checkout is not connected yet.'

    });

  }
);


app.post(
  '/api/checkout/prepaid/verify',
  function (req, res) {

    res.status(501).json({

      success: false,

      message:
        'Payment verification is not connected yet.'

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

      message:
        'Internal server error.'

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
