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

- Render / Node.js server
- Shopify Admin API authentication
- Shopify connection test
- Razorpay connection
- Razorpay test order
- Checkout data validation

NOT YET ENABLED:

- Live COD Shopify orders
- Live prepaid Shopify orders
- Razorpay payment verification
- Discount processing
- Final shipping calculation
- Cart clearing
- Wishlist redirect

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
BASIC SERVER
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
*/

let shopifyToken = null;
let shopifyTokenExpiresAt = 0;


async function getShopifyAccessToken() {

  const now = Date.now();


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
*/

app.post(
  '/api/test/razorpay',
  async function (req, res) {

    try {

      if (!razorpay) {

        return res.status(500).json({

          success: false,

          message:
            'Razorpay environment variables are not configured.'

        });

      }


      const amount =
        Number(req.body.amount);


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


      const amountInPaise =
        Math.round(amount * 100);


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
CHECKOUT DATA VALIDATION
============================================================

This endpoint does NOT create an order.

It only checks that the checkout drawer is sending the
basic information our backend will need.

EXPECTED DATA:

{
  "customer": {
    "firstName": "...",
    "lastName": "...",
    "email": "...",
    "phone": "..."
  },

  "shippingAddress": {
    "address1": "...",
    "address2": "...",
    "city": "...",
    "state": "...",
    "postalCode": "...",
    "country": "India"
  },

  "items": [
    {
      "variantId": "...",
      "quantity": 1
    }
  ],

  "discountCode": "OPTIONAL",

  "paymentMethod": "cod"
}

============================================================
*/

app.post(
  '/api/checkout/validate',
  function (req, res) {

    try {

      const body =
        req.body || {};


      const customer =
        body.customer || {};


      const shippingAddress =
        body.shippingAddress || {};


      const items =
        Array.isArray(body.items)
          ? body.items
          : [];


      /*
      Basic customer validation.
      */

      if (!customer.email) {

        return res.status(400).json({

          success: false,

          message:
            'Customer email is required.'

        });

      }


      /*
      Basic address validation.
      */

      if (
        !shippingAddress.address1 ||
        !shippingAddress.city ||
        !shippingAddress.state ||
        !shippingAddress.postalCode
      ) {

        return res.status(400).json({

          success: false,

          message:
            'Complete shipping address is required.'

        });

      }


      /*
      Product validation.
      */

      if (items.length === 0) {

        return res.status(400).json({

          success: false,

          message:
            'At least one cart item is required.'

        });

      }


      for (
        const item of items
      ) {

        if (
          !item.variantId ||
          !Number.isInteger(
            Number(item.quantity)
          ) ||
          Number(item.quantity) < 1
        ) {

          return res.status(400).json({

            success: false,

            message:
              'Every cart item must contain a valid variant ID and quantity.'

          });

        }

      }


      /*
      Payment method validation.
      */

      const allowedPaymentMethods = [
        'cod',
        'upi',
        'card',
        'wallet',
        'netbanking'
      ];


      const paymentMethod =
        body.paymentMethod;


      if (
        !allowedPaymentMethods.includes(
          paymentMethod
        )
      ) {

        return res.status(400).json({

          success: false,

          message:
            'Invalid payment method.'

        });

      }


      /*
      Discount code is optional.
      */

      const discountCode =
        typeof body.discountCode === 'string'
          ? body.discountCode.trim()
          : '';


      /*
      Everything passed the basic validation.
      */

      return res.json({

        success: true,

        validated: true,

        message:
          'Checkout data received successfully.',

        checkout: {

          paymentMethod,

          itemCount:
            items.length,

          discountCodeProvided:
            Boolean(discountCode)

        }

      });


    } catch (error) {

      console.error(
        'Checkout validation error:',
        error
      );


      return res.status(500).json({

        success: false,

        message:
          'Unable to validate checkout data.'

      });

    }

  }
);


/*
============================================================
LIVE CHECKOUT ROUTES
============================================================

These remain disabled until we finish validation,
pricing, discounts, shipping and payment verification.

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
