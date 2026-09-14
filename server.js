const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const crypto = require('crypto');
const Razorpay = require('razorpay');

dotenv.config();

const app = express();

/* =========================================================
   CORS
========================================================= */

const ALLOWED_ORIGINS = [
  'https://www.vynix.co.in',
  'https://vynix.co.in'
];

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) {
        return callback(null, true);
      }

      if (ALLOWED_ORIGINS.includes(origin)) {
        return callback(null, true);
      }

      return callback(
        new Error('CORS origin not allowed.')
      );
    },
    credentials: true
  })
);

app.use(
  express.json({
    limit: '1mb'
  })
);

/* =========================================================
   CONFIG
========================================================= */

const PORT =
  process.env.PORT || 10000;

const SHOPIFY_STORE_DOMAIN =
  process.env.SHOPIFY_STORE_DOMAIN || '';

const SHOPIFY_CLIENT_ID =
  process.env.SHOPIFY_CLIENT_ID || '';

const SHOPIFY_CLIENT_SECRET =
  process.env.SHOPIFY_CLIENT_SECRET || '';

const RAZORPAY_KEY_ID =
  process.env.RAZORPAY_KEY_ID || '';

const RAZORPAY_KEY_SECRET =
  process.env.RAZORPAY_KEY_SECRET || '';

const SHOPIFY_API_VERSION =
  '2026-07';

const FREE_SHIPPING_THRESHOLD =
  1499;

const SHIPPING_FEE =
  35;

/* =========================================================
   RAZORPAY
========================================================= */

const razorpay =
  RAZORPAY_KEY_ID &&
  RAZORPAY_KEY_SECRET
    ? new Razorpay({
        key_id: RAZORPAY_KEY_ID,
        key_secret: RAZORPAY_KEY_SECRET
      })
    : null;

/* =========================================================
   SHOPIFY TOKEN CACHE
========================================================= */

let shopifyAccessToken = null;

let shopifyAccessTokenExpiresAt = 0;

/* =========================================================
   PREPAID DUPLICATE PROTECTION
========================================================= */

const processedPrepaidPayments =
  new Map();

/* =========================================================
   BASIC HELPERS
========================================================= */

function cleanString(value) {
  if (
    value === null ||
    value === undefined
  ) {
    return '';
  }

  return String(value).trim();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
    cleanString(email)
  );
}

function normalizeMoney(value) {
  return Number(
    Number(value || 0).toFixed(2)
  );
}

function normalizeCountryCode(country) {
  const value =
    cleanString(country).toUpperCase();

  if (!value) {
    return 'IN';
  }

  if (value === 'INDIA') {
    return 'IN';
  }

  if (value === 'IN') {
    return 'IN';
  }

  return value.length === 2
    ? value
    : 'IN';
}

function normalizeStateCode(state) {
  const value =
    cleanString(state);

  const stateMap = {
    'Andhra Pradesh': 'AP',
    'Arunachal Pradesh': 'AR',
    'Assam': 'AS',
    'Bihar': 'BR',
    'Chhattisgarh': 'CT',
    'Goa': 'GA',
    'Gujarat': 'GJ',
    'Haryana': 'HR',
    'Himachal Pradesh': 'HP',
    'Jharkhand': 'JH',
    'Karnataka': 'KA',
    'Kerala': 'KL',
    'Madhya Pradesh': 'MP',
    'Maharashtra': 'MH',
    'Manipur': 'MN',
    'Meghalaya': 'ML',
    'Mizoram': 'MZ',
    'Nagaland': 'NL',
    'Odisha': 'OR',
    'Punjab': 'PB',
    'Rajasthan': 'RJ',
    'Sikkim': 'SK',
    'Tamil Nadu': 'TN',
    'Telangana': 'TS',
    'Tripura': 'TR',
    'Uttar Pradesh': 'UP',
    'Uttarakhand': 'UK',
    'West Bengal': 'WB',
    'Delhi': 'DL',
    'Jammu and Kashmir': 'JK',
    'Ladakh': 'LA',
    'Puducherry': 'PY',
    'Chandigarh': 'CH'
  };

  return (
    stateMap[value] ||
    value
  );
}

function cleanVariantId(value) {
  const stringValue =
    cleanString(value);

  if (!stringValue) {
    return '';
  }

  if (
    stringValue.startsWith(
      'gid://shopify/ProductVariant/'
    )
  ) {
    return stringValue;
  }

  const numericId =
    stringValue.replace(
      /[^0-9]/g,
      ''
    );

  if (!numericId) {
    return '';
  }

  return (
    'gid://shopify/ProductVariant/' +
    numericId
  );
}

/* =========================================================
   VALIDATE CHECKOUT REQUEST
========================================================= */

function assertCheckoutRequest(body) {
  if (
    !body ||
    typeof body !== 'object'
  ) {
    throw new Error(
      'Invalid checkout request.'
    );
  }

  if (
    !body.customer ||
    typeof body.customer !== 'object'
  ) {
    throw new Error(
      'Customer details are required.'
    );
  }

  if (
    !isValidEmail(
      body.customer.email
    )
  ) {
    throw new Error(
      'Please enter a valid email address.'
    );
  }

  if (
    !body.shippingAddress ||
    typeof body.shippingAddress !== 'object'
  ) {
    throw new Error(
      'Shipping address is required.'
    );
  }

  if (
    !Array.isArray(body.items) ||
    body.items.length === 0
  ) {
    throw new Error(
      'Your cart is empty.'
    );
  }

  for (
    const item of body.items
  ) {
    const variantId =
      cleanVariantId(
        item &&
        item.variantId
      );

    const quantity =
      Number(
        item &&
        item.quantity
      );

    if (!variantId) {
      throw new Error(
        'A valid product variant is required.'
      );
    }

    if (
      !Number.isInteger(quantity) ||
      quantity < 1
    ) {
      throw new Error(
        'Invalid product quantity.'
      );
    }
  }
}

/* =========================================================
   SHOPIFY ACCESS TOKEN
========================================================= */

async function getShopifyAccessToken() {
  if (
    shopifyAccessToken &&
    Date.now() <
      shopifyAccessTokenExpiresAt
  ) {
    return shopifyAccessToken;
  }

  if (
    !SHOPIFY_STORE_DOMAIN ||
    !SHOPIFY_CLIENT_ID ||
    !SHOPIFY_CLIENT_SECRET
  ) {
    throw new Error(
      'Shopify client credentials are not configured.'
    );
  }

  const response =
    await fetch(
      `https://${SHOPIFY_STORE_DOMAIN}/admin/oauth/access_token`,
      {
        method: 'POST',
        headers: {
          'Content-Type':
            'application/json'
        },
        body: JSON.stringify({
          client_id:
            SHOPIFY_CLIENT_ID,
          client_secret:
            SHOPIFY_CLIENT_SECRET,
          grant_type:
            'client_credentials'
        })
      }
    );

  const data =
    await response.json();

  if (
    !response.ok ||
    !data.access_token
  ) {
    throw new Error(
      data.error_description ||
      data.error ||
      'Shopify access token was not returned.'
    );
  }

  shopifyAccessToken =
    data.access_token;

  shopifyAccessTokenExpiresAt =
    Date.now() +
    (
      Number(
        data.expires_in ||
        86399
      ) *
      1000
    ) -
    60000;

  return shopifyAccessToken;
}

/* =========================================================
   SHOPIFY GRAPHQL
========================================================= */

async function shopifyGraphQL(
  query,
  variables
) {
  const token =
    await getShopifyAccessToken();

  const response =
    await fetch(
      `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type':
            'application/json',
          'X-Shopify-Access-Token':
            token
        },
        body: JSON.stringify({
          query,
          variables:
            variables || {}
        })
      }
    );

  const payload =
    await response.json();

  if (!response.ok) {
    throw new Error(
      payload &&
      payload.errors
        ? JSON.stringify(
            payload.errors
          )
        : 'Shopify API request failed.'
    );
  }

  if (
    payload.errors &&
    payload.errors.length
  ) {
    throw new Error(
      payload.errors
        .map(
          error =>
            error.message
        )
        .join('; ')
    );
  }

  return payload.data;
}

/* =========================================================
   GET REAL SHOPIFY VARIANT DETAILS
========================================================= */

async function getVariantDetails(
  items
) {
  const uniqueVariantIds =
    [
      ...new Set(
        items.map(
          item =>
            cleanVariantId(
              item.variantId
            )
        )
      )
    ];

  const details = {};

  for (
    const variantId of
      uniqueVariantIds
  ) {
    const data =
      await shopifyGraphQL(
        `
        query GetVariant($id: ID!) {
          productVariant(id: $id) {
            id
            title
            price
            product {
              title
            }
          }
        }
        `,
        {
          id: variantId
        }
      );

    if (
      !data ||
      !data.productVariant
    ) {
      throw new Error(
        'One of the products in your cart is no longer available.'
      );
    }

    details[variantId] =
      data.productVariant;
  }

  return details;
}

/* =========================================================
   DISCOUNT DETAILS
========================================================= */

async function getDiscountCodeDetails(
  discountCode
) {
  const code =
    cleanString(
      discountCode
    );

  if (!code) {
    return null;
  }

  const data =
    await shopifyGraphQL(
      `
      query GetDiscount($code: String!) {
        codeDiscountNodeByCode(code: $code) {
          id

          codeDiscount {
            __typename

            ... on DiscountCodeBasic {
              title
              status
              startsAt
              endsAt

              customerGets {
                value {
                  ... on DiscountPercentage {
                    percentage
                  }

                  ... on DiscountAmount {
                    amount {
                      amount
                      currencyCode
                    }

                    appliesOnEachItem
                  }
                }
              }
            }
          }
        }
      }
      `,
      {
        code
      }
    );

  const node =
    data &&
    data.codeDiscountNodeByCode
      ? data.codeDiscountNodeByCode
      : null;

  if (
    !node ||
    !node.codeDiscount
  ) {
    throw new Error(
      'Invalid or expired discount code.'
    );
  }

  const discount =
    node.codeDiscount;

  if (
    discount.__typename !==
    'DiscountCodeBasic'
  ) {
    throw new Error(
      'This discount code type is not supported by the custom checkout.'
    );
  }

  if (
    discount.status !==
    'ACTIVE'
  ) {
    throw new Error(
      'This discount code is not active.'
    );
  }

  const now =
    Date.now();

  if (
    discount.startsAt &&
    now <
      new Date(
        discount.startsAt
      ).getTime()
  ) {
    throw new Error(
      'This discount code is not active yet.'
    );
  }

  if (
    discount.endsAt &&
    now >
      new Date(
        discount.endsAt
      ).getTime()
  ) {
    throw new Error(
      'This discount code has expired.'
    );
  }

  const value =
    discount.customerGets &&
    discount.customerGets.value
      ? discount.customerGets.value
      : null;

  if (!value) {
    throw new Error(
      'This discount code has no usable discount value.'
    );
  }

  return {
    code,
    title:
      discount.title ||
      code,

    type:
      typeof value.percentage ===
      'number'
        ? 'percentage'
        : 'fixed',

    percentage:
      typeof value.percentage ===
      'number'
        ? Number(
            value.percentage
          )
        : null,

    amount:
      value.amount &&
      value.amount.amount
        ? Number(
            value.amount.amount
          )
        : null,

    currencyCode:
      value.amount &&
      value.amount.currencyCode
        ? value.amount.currencyCode
        : 'INR'
  };
}

/* =========================================================
   BUILD SHOPIFY DISCOUNT INPUT
========================================================= */

function buildDiscountInput(
  discount
) {
  if (!discount) {
    return null;
  }

  if (
    discount.type ===
    'percentage'
  ) {
    return {
      itemPercentageDiscountCode: {
        code:
          discount.code,
        percentage:
          discount.percentage
      }
    };
  }

  return {
    itemFixedDiscountCode: {
      code:
        discount.code,

      amountSet: {
        shopMoney: {
          amount:
            normalizeMoney(
              discount.amount
            ),
          currencyCode:
            'INR'
        }
      }
    }
  };
}

/* =========================================================
   CALCULATE DISCOUNT
========================================================= */

function calculateDiscountAmount(
  subtotal,
  discount,
  totalQuantity
) {
  if (!discount) {
    return 0;
  }

  if (
    discount.type ===
    'percentage'
  ) {
    return normalizeMoney(
      subtotal *
        Number(
          discount.percentage
        )
    );
  }

  if (
    discount.amount === null
  ) {
    return 0;
  }

  if (
    discount.currencyCode ===
    'INR'
  ) {
    return normalizeMoney(
      Math.min(
        subtotal,
        Number(
          discount.amount
        )
      )
    );
  }

  return 0;
}

/* =========================================================
   CALCULATE COMPLETE CHECKOUT
========================================================= */

async function calculateCheckoutTotals(
  items,
  discountCode
) {
  const variantDetails =
    await getVariantDetails(
      items
    );

  let subtotal = 0;

  let totalQuantity = 0;

  const lineItems =
    items.map(item => {
      const variantId =
        cleanVariantId(
          item.variantId
        );

      const quantity =
        Number(
          item.quantity
        );

      const variant =
        variantDetails[
          variantId
        ];

      const price =
        Number(
          variant.price
        );

      subtotal +=
        price * quantity;

      totalQuantity +=
        quantity;

      return {
        variantId,
        quantity,
        title:
          variant.product
            ? variant.product.title
            : variant.title,
        price
      };
    });

  subtotal =
    normalizeMoney(
      subtotal
    );

  let discountDetails =
    null;

  let discountInput =
    null;

  let discountAmount =
    0;

  if (
    cleanString(
      discountCode
    )
  ) {
    discountDetails =
      await getDiscountCodeDetails(
        discountCode
      );

    discountInput =
      buildDiscountInput(
        discountDetails
      );

    discountAmount =
      calculateDiscountAmount(
        subtotal,
        discountDetails,
        totalQuantity
      );
  }

  const discountedMerchandiseSubtotal =
    normalizeMoney(
      Math.max(
        0,
        subtotal -
          discountAmount
      )
    );

  const shippingAmount =
    discountedMerchandiseSubtotal >=
    FREE_SHIPPING_THRESHOLD
      ? 0
      : SHIPPING_FEE;

  const total =
    normalizeMoney(
      discountedMerchandiseSubtotal +
        shippingAmount
    );

  return {
    variantDetails,
    lineItems,
    subtotal,
    discountDetails,
    discountInput,
    discountAmount,
    discountedMerchandiseSubtotal,
    shippingAmount,
    total
  };
}

/* =========================================================
   BUILD SHOPIFY ADDRESS
========================================================= */

function buildShopifyAddress(
  address,
  customer,
  recipientName
) {
  const recipientParts =
    cleanString(
      recipientName || ''
    )
      .split(/\s+/)
      .filter(Boolean);

  const firstName =
    recipientParts.shift() ||
    cleanString(
      customer.firstName
    ) ||
    'Customer';

  const lastName =
    recipientParts.join(' ') ||
    cleanString(
      customer.lastName
    ) ||
    '';

  return {
    firstName,
    lastName,

    address1:
      cleanString(
        address.address1
      ),

    address2:
      cleanString(
        address.address2
      ),

    city:
      cleanString(
        address.city
      ),

    province:
      cleanString(
        address.state
      ),

    provinceCode:
      normalizeStateCode(
        address.state
      ),

    country:
      cleanString(
        address.country
      ) || 'India',

    countryCode:
      normalizeCountryCode(
        address.country
      ),

    zip:
      cleanString(
        address.postalCode
      ),

    phone:
      cleanString(
        address.phone
      ) ||
      cleanString(
        customer.phone
      )
  };
}

/* =========================================================
   ROOT
========================================================= */

app.get(
  '/',
  (req, res) => {
    res.status(200).json({
      success: true,
      message:
        'VYNIX BACKEND IS RUNNING'
    });
  }
);

/* =========================================================
   HEALTH
========================================================= */

app.get(
  '/health',
  (req, res) => {
    res.status(200).json({
      success: true,
      status: 'healthy',

      shopifyConfigured:
        Boolean(
          SHOPIFY_STORE_DOMAIN &&
          SHOPIFY_CLIENT_ID &&
          SHOPIFY_CLIENT_SECRET
        ),

      razorpayConfigured:
        Boolean(razorpay),

      message:
        'VYNIX BACKEND IS ONLINE'
    });
  }
);

/* =========================================================
   WARMUP
========================================================= */

app.get(
  '/api/checkout/warmup',
  async (req, res) => {
    try {
      await getShopifyAccessToken();

      return res.status(200).json({
        success: true,
        message:
          'VYNIX CHECKOUT BACKEND IS READY'
      });
    } catch (error) {
      console.error(
        'WARMUP ERROR:',
        error
      );

      return res.status(500).json({
        success: false,
        message:
          error.message ||
          'Checkout backend warmup failed.'
      });
    }
  }
);

/* =========================================================
   SHOPIFY TEST
========================================================= */

app.get(
  '/api/test/shopify',
  async (req, res) => {
    try {
      const data =
        await shopifyGraphQL(`
          query {
            shop {
              name
              myshopifyDomain
            }
          }
        `);

      return res.status(200).json({
        success: true,
        shop:
          data.shop
      });
    } catch (error) {
      console.error(
        'SHOPIFY TEST ERROR:',
        error
      );

      return res.status(500).json({
        success: false,
        message:
          error.message ||
          'Shopify test failed.'
      });
    }
  }
);

/* =========================================================
   RAZORPAY TEST
========================================================= */

app.get(
  '/api/test/razorpay',
  async (req, res) => {
    if (!razorpay) {
      return res.status(500).json({
        success: false,
        message:
          'Razorpay credentials are not configured.'
      });
    }

    try {
      const payments =
        await razorpay.payments.all({
          count: 1
        });

      return res.status(200).json({
        success: true,
        message:
          'RAZORPAY CONNECTION SUCCESSFUL',

        paymentCount:
          payments &&
          payments.items
            ? payments.items.length
            : 0
      });
    } catch (error) {
      console.error(
        'RAZORPAY TEST ERROR:',
        error
      );

      return res.status(500).json({
        success: false,
        message:
          error.message ||
          'Razorpay test failed.'
      });
    }
  }
);

/* =========================================================
   CHECKOUT VALIDATION
========================================================= */

app.post(
  '/api/checkout/validate',
  async (req, res) => {
    try {
      assertCheckoutRequest(
        req.body
      );

      const totals =
        await calculateCheckoutTotals(
          req.body.items,
          cleanString(
            req.body.discountCode
          )
        );

      return res.status(200).json({
        success: true,

        checkout: {
          subtotal:
            totals.subtotal,

          discount:
            totals.discountAmount,

          shipping:
            totals.shippingAmount,

          total:
            totals.total,

          currency:
            'INR'
        }
      });
    } catch (error) {
      console.error(
        'CHECKOUT VALIDATION ERROR:',
        error
      );

      return res.status(400).json({
        success: false,
        message:
          error.message ||
          'Checkout validation failed.'
      });
    }
  }
);

/* =========================================================
   COD ORDER
   EXISTING WORKING SYSTEM
========================================================= */

app.post(
  '/api/checkout/cod',
  async (req, res) => {
    try {
      const body =
        req.body || {};

      assertCheckoutRequest(
        body
      );

      const customer =
        body.customer;

      const address =
        body.shippingAddress;

      if (
        !cleanString(
          customer.firstName
        )
      ) {
        throw new Error(
          'Customer first name is required.'
        );
      }

      if (
        !cleanString(
          address.address1
        )
      ) {
        throw new Error(
          'Complete delivery address is required.'
        );
      }

      if (
        !cleanString(
          address.city
        )
      ) {
        throw new Error(
          'City is required.'
        );
      }

      if (
        !cleanString(
          address.postalCode
        )
      ) {
        throw new Error(
          'PIN code is required.'
        );
      }

      const totals =
        await calculateCheckoutTotals(
          body.items,
          cleanString(
            body.discountCode
          )
        );

      const shippingAddress =
        buildShopifyAddress(
          address,
          customer,
          address.recipientName ||
            `${customer.firstName || ''} ${customer.lastName || ''}`.trim()
        );

      const lineItems =
        totals.lineItems.map(
          item => ({
            variantId:
              item.variantId,

            quantity:
              item.quantity,

            requiresShipping:
              true
          })
        );

      const orderInput = {
        email:
          cleanString(
            customer.email
          ),

        phone:
          cleanString(
            customer.phone
          ),

        currency:
          'INR',

        presentmentCurrency:
          'INR',

        financialStatus:
          'PENDING',

        lineItems,

        shippingAddress,

        billingAddress:
          shippingAddress,

        shippingLines: [
          {
            title:
              totals.shippingAmount === 0
                ? 'Free Shipping'
                : 'Standard Shipping',

            priceSet: {
              shopMoney: {
                amount:
                  totals.shippingAmount,

                currencyCode:
                  'INR'
              }
            }
          }
        ],

        note:
          'VYNIX Custom Checkout - Cash on Delivery',

        customAttributes: [
          {
            key:
              'Payment Method',

            value:
              'COD'
          },

          {
            key:
              'Checkout Source',

            value:
              'VYNIX Custom Checkout'
          }
        ],

        sourceName:
          'VYNIX Custom Checkout'
      };

      if (
        totals.discountInput
      ) {
        orderInput.discountCode =
          totals.discountInput;
      }

      if (
        cleanString(
          customer.id
        )
      ) {
        orderInput.customer = {
          toAssociate: {
            id:
              cleanString(
                customer.id
              )
          }
        };
      } else {
        orderInput.customer = {
          toUpsert: {
            firstName:
              cleanString(
                customer.firstName
              ),

            lastName:
              cleanString(
                customer.lastName
              ),

            email:
              cleanString(
                customer.email
              ),

            phone:
              cleanString(
                customer.phone
              )
          }
        };
      }

      const mutation = `
        mutation CreateVynixCodOrder(
          $order: OrderCreateOrderInput!
        ) {
          orderCreate(
            order: $order
          ) {
            userErrors {
              field
              message
            }

            order {
              id
              name
              displayFinancialStatus

              totalPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
            }
          }
        }
      `;

      const data =
        await shopifyGraphQL(
          mutation,
          {
            order:
              orderInput
          }
        );

      const payload =
        data &&
        data.orderCreate
          ? data.orderCreate
          : null;

      if (!payload) {
        throw new Error(
          'Shopify did not return an order creation result.'
        );
      }

      if (
        payload.userErrors &&
        payload.userErrors.length
      ) {
        throw new Error(
          payload.userErrors
            .map(
              error =>
                error.message
            )
            .join('; ')
        );
      }

      if (!payload.order) {
        throw new Error(
          'Shopify order was not created.'
        );
      }

      return res.status(200).json({
        success: true,

        orderCreated:
          true,

        order: {
          id:
            payload.order.id,

          name:
            payload.order.name,

          financialStatus:
            payload.order
              .displayFinancialStatus,

          total:
            Number(
              payload.order
                .totalPriceSet
                .shopMoney
                .amount
            ),

          currency:
            payload.order
              .totalPriceSet
              .shopMoney
              .currencyCode
        },

        checkout: {
          paymentMethod:
            'cod',

          subtotal:
            totals.subtotal,

          discount:
            totals.discountAmount,

          shipping:
            totals.shippingAmount,

          total:
            totals.total
        },

        message:
          'COD order created successfully.'
      });
    } catch (error) {
      console.error(
        'COD ORDER ERROR:',
        error
      );

      return res.status(400).json({
        success: false,

        orderCreated:
          false,

        message:
          error.message ||
          'Unable to create COD order.'
      });
    }
  }
);

/* =========================================================
   FIND EXISTING PREPAID SHOPIFY ORDER
========================================================= */

async function findPrepaidShopifyOrder(
  razorpayOrderId
) {
  const sourceIdentifier =
    cleanString(
      razorpayOrderId
    );

  if (!sourceIdentifier) {
    return null;
  }

  const data =
    await shopifyGraphQL(
      `
      query FindPrepaidOrder(
        $query: String!
      ) {
        orders(
          first: 1,
          query: $query
        ) {
          nodes {
            id
            name
            displayFinancialStatus

            totalPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }
          }
        }
      }
      `,
      {
        query:
          `source_identifier:${sourceIdentifier}`
      }
    );

  if (
    data &&
    data.orders &&
    data.orders.nodes &&
    data.orders.nodes.length
  ) {
    return data.orders.nodes[0];
  }

  return null;
}

/* =========================================================
   PREPAID — CREATE RAZORPAY ORDER
========================================================= */

app.post(
  '/api/checkout/prepaid/create',
  async (req, res) => {
    try {
      if (!razorpay) {
        return res.status(500).json({
          success: false,
          message:
            'Razorpay credentials are not configured.'
        });
      }

      const body =
        req.body || {};

      assertCheckoutRequest(
        body
      );

      const paymentMethod =
        cleanString(
          body.paymentMethod
        ).toLowerCase();

      const allowedMethods = [
        'upi',
        'card',
        'wallet',
        'netbanking'
      ];

      if (
        !allowedMethods.includes(
          paymentMethod
        )
      ) {
        return res.status(400).json({
          success: false,
          message:
            'Please select a valid prepaid payment method.'
        });
      }

      /*
        IMPORTANT:
        Total is calculated again on the server.
        We NEVER trust the amount sent by
        the browser.
      */

      const totals =
        await calculateCheckoutTotals(
          body.items,
          cleanString(
            body.discountCode
          )
        );

      const amountPaise =
        Math.round(
          totals.total * 100
        );

      if (
        amountPaise <= 0
      ) {
        throw new Error(
          'Invalid checkout amount.'
        );
      }

      const razorpayOrder =
        await razorpay.orders.create({
          amount:
            amountPaise,

          currency:
            'INR',

          receipt:
            `vynix_${Date.now()}`,

          notes: {
            source:
              'VYNIX Custom Checkout',

            paymentMethod,

            email:
              cleanString(
                body.customer.email
              )
          }
        });

      return res.status(200).json({
        success: true,

        keyId:
          RAZORPAY_KEY_ID,

        orderId:
          razorpayOrder.id,

        amount:
          razorpayOrder.amount,

        currency:
          razorpayOrder.currency,

        checkout: {
          paymentMethod,

          subtotal:
            totals.subtotal,

          discount:
            totals.discountAmount,

          shipping:
            totals.shippingAmount,

          total:
            totals.total
        }
      });
    } catch (error) {
      console.error(
        'PREPAID CREATE ERROR:',
        error
      );

      return res.status(400).json({
        success: false,

        message:
          error.message ||
          'Unable to start prepaid payment.'
      });
    }
  }
);

/* =========================================================
   PREPAID — VERIFY PAYMENT
   THEN CREATE PAID SHOPIFY ORDER
========================================================= */

app.post(
  '/api/checkout/prepaid/verify',
  async (req, res) => {
    try {
      if (!razorpay) {
        return res.status(500).json({
          success: false,
          message:
            'Razorpay credentials are not configured.'
        });
      }

      const body =
        req.body || {};

      assertCheckoutRequest(
        body
      );

      const razorpayOrderId =
        cleanString(
          body.razorpayOrderId
        );

      const razorpayPaymentId =
        cleanString(
          body.razorpayPaymentId
        );

      const razorpaySignature =
        cleanString(
          body.razorpaySignature
        );

      if (
        !razorpayOrderId ||
        !razorpayPaymentId ||
        !razorpaySignature
      ) {
        throw new Error(
          'Razorpay payment verification details are incomplete.'
        );
      }

      /*
        If the same browser sends the verification
        twice, return the already-created result.
      */

      const cachedResult =
        processedPrepaidPayments.get(
          razorpayPaymentId
        );

      if (cachedResult) {
        return res.status(200).json(
          cachedResult
        );
      }

      /* =====================================================
         VERIFY RAZORPAY SIGNATURE
      ===================================================== */

      const generatedSignature =
        crypto
          .createHmac(
            'sha256',
            RAZORPAY_KEY_SECRET
          )
          .update(
            `${razorpayOrderId}|${razorpayPaymentId}`
          )
          .digest('hex');

      const generatedBuffer =
        Buffer.from(
          generatedSignature,
          'utf8'
        );

      const receivedBuffer =
        Buffer.from(
          razorpaySignature,
          'utf8'
        );

      if (
        generatedBuffer.length !==
          receivedBuffer.length ||
        !crypto.timingSafeEqual(
          generatedBuffer,
          receivedBuffer
        )
      ) {
        throw new Error(
          'Razorpay payment signature verification failed.'
        );
      }

      /* =====================================================
         CALCULATE TOTAL AGAIN
      ===================================================== */

      const totals =
        await calculateCheckoutTotals(
          body.items,
          cleanString(
            body.discountCode
          )
        );

      const expectedAmountPaise =
        Math.round(
          totals.total * 100
        );

      /* =====================================================
         FETCH RAZORPAY ORDER
      ===================================================== */

      const razorpayOrder =
        await razorpay.orders.fetch(
          razorpayOrderId
        );

      if (!razorpayOrder) {
        throw new Error(
          'Razorpay order could not be found.'
        );
      }

      if (
        Number(
          razorpayOrder.amount
        ) !==
        expectedAmountPaise
      ) {
        throw new Error(
          'Razorpay amount does not match the VYNIX order total.'
        );
      }

      if (
        cleanString(
          razorpayOrder.currency
        ).toUpperCase() !==
        'INR'
      ) {
        throw new Error(
          'Razorpay currency does not match the VYNIX checkout currency.'
        );
      }

      /* =====================================================
         FETCH RAZORPAY PAYMENT
      ===================================================== */

      const payment =
        await razorpay.payments.fetch(
          razorpayPaymentId
        );

      if (!payment) {
        throw new Error(
          'Razorpay payment could not be found.'
        );
      }

      if (
        cleanString(
          payment.order_id
        ) !==
        razorpayOrderId
      ) {
        throw new Error(
          'Razorpay payment does not belong to this order.'
        );
      }

      if (
        Number(
          payment.amount
        ) !==
        expectedAmountPaise
      ) {
        throw new Error(
          'Razorpay payment amount does not match the VYNIX order total.'
        );
      }

      if (
        cleanString(
          payment.currency
        ).toUpperCase() !==
        'INR'
      ) {
        throw new Error(
          'Razorpay payment currency is invalid.'
        );
      }

      /*
        VERY IMPORTANT:
        Payment must actually be captured.
      */

      if (
        payment.status !==
        'captured'
      ) {
        throw new Error(
          `Razorpay payment is not captured. Current status: ${payment.status || 'unknown'}.`
        );
      }

      /* =====================================================
         DUPLICATE SHOPIFY ORDER CHECK
      ===================================================== */

      const existingOrder =
        await findPrepaidShopifyOrder(
          razorpayOrderId
        );

      if (existingOrder) {
        const existingResult = {
          success: true,

          orderCreated:
            true,

          paymentVerified:
            true,

          order: {
            id:
              existingOrder.id,

            name:
              existingOrder.name,

            financialStatus:
              existingOrder
                .displayFinancialStatus,

            total:
              Number(
                existingOrder
                  .totalPriceSet
                  .shopMoney
                  .amount
              ),

            currency:
              existingOrder
                .totalPriceSet
                .shopMoney
                .currencyCode
          },

          checkout: {
            paymentMethod:
              cleanString(
                payment.method
              ),

            subtotal:
              totals.subtotal,

            discount:
              totals.discountAmount,

            shipping:
              totals.shippingAmount,

            total:
              totals.total
          },

          message:
            'Prepaid order already exists for this Razorpay payment.'
        };

        processedPrepaidPayments.set(
          razorpayPaymentId,
          existingResult
        );

        return res.status(200).json(
          existingResult
        );
      }

      /* =====================================================
         SHOPIFY ORDER DATA
      ===================================================== */

      const customer =
        body.customer;

      const address =
        body.shippingAddress;

      const shippingAddress =
        buildShopifyAddress(
          address,
          customer,
          address.recipientName ||
            `${customer.firstName || ''} ${customer.lastName || ''}`.trim()
        );

      const lineItems =
        totals.lineItems.map(
          item => ({
            variantId:
              item.variantId,

            quantity:
              item.quantity,

            requiresShipping:
              true
          })
        );

      /* =====================================================
         CREATE PAID SHOPIFY ORDER
      ===================================================== */

      const orderInput = {
        email:
          cleanString(
            customer.email
          ),

        phone:
          cleanString(
            customer.phone
          ),

        currency:
          'INR',

        presentmentCurrency:
          'INR',

        financialStatus:
          'PAID',

        lineItems,

        shippingAddress,

        billingAddress:
          shippingAddress,

        shippingLines: [
          {
            title:
              totals.shippingAmount === 0
                ? 'Free Shipping'
                : 'Standard Shipping',

            priceSet: {
              shopMoney: {
                amount:
                  totals.shippingAmount,

                currencyCode:
                  'INR'
              }
            }
          }
        ],

        note:
          `VYNIX Custom Checkout - Razorpay Prepaid | Razorpay Payment ID: ${razorpayPaymentId}`,

        customAttributes: [
          {
            key:
              'Payment Method',

            value:
              `Razorpay - ${cleanString(payment.method)}`
          },

          {
            key:
              'Checkout Source',

            value:
              'VYNIX Custom Checkout'
          },

          {
            key:
              'Razorpay Order ID',

            value:
              razorpayOrderId
          },

          {
            key:
              'Razorpay Payment ID',

            value:
              razorpayPaymentId
          }
        ],

        sourceName:
          'VYNIX Custom Checkout',

        sourceIdentifier:
          razorpayOrderId,

        transactions: [
          {
            kind:
              'SALE',

            status:
              'SUCCESS',

            gateway:
              'Razorpay',

            amountSet: {
              shopMoney: {
                amount:
                  totals.total,

                currencyCode:
                  'INR'
              }
            },

            processedAt:
              new Date().toISOString(),

            receiptJson:
              JSON.stringify({
                razorpayOrderId,
                razorpayPaymentId,
                razorpayMethod:
                  payment.method,
                razorpaySignature
              })
          }
        ]
      };

      if (
        totals.discountInput
      ) {
        orderInput.discountCode =
          totals.discountInput;
      }

      /* =====================================================
         CUSTOMER
      ===================================================== */

      if (
        cleanString(
          customer.id
        )
      ) {
        orderInput.customer = {
          toAssociate: {
            id:
              cleanString(
                customer.id
              )
          }
        };
      } else {
        orderInput.customer = {
          toUpsert: {
            firstName:
              cleanString(
                customer.firstName
              ),

            lastName:
              cleanString(
                customer.lastName
              ),

            email:
              cleanString(
                customer.email
              ),

            phone:
              cleanString(
                customer.phone
              )
          }
        };
      }

      /* =====================================================
         SHOPIFY MUTATION
      ===================================================== */

      const mutation = `
        mutation CreateVynixPrepaidOrder(
          $order: OrderCreateOrderInput!
        ) {
          orderCreate(
            order: $order
          ) {
            userErrors {
              field
              message
            }

            order {
              id
              name
              displayFinancialStatus

              totalPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
            }
          }
        }
      `;

      const data =
        await shopifyGraphQL(
          mutation,
          {
            order:
              orderInput
          }
        );

      const payload =
        data &&
        data.orderCreate
          ? data.orderCreate
          : null;

      if (!payload) {
        throw new Error(
          'Shopify did not return an order creation result after payment verification.'
        );
      }

      if (
        payload.userErrors &&
        payload.userErrors.length
      ) {
        throw new Error(
          payload.userErrors
            .map(
              error =>
                error.message
            )
            .join('; ')
        );
      }

      if (!payload.order) {
        throw new Error(
          'Payment was captured, but Shopify did not create the order.'
        );
      }

      /* =====================================================
         SUCCESS
      ===================================================== */

      const result = {
        success: true,

        orderCreated:
          true,

        paymentVerified:
          true,

        order: {
          id:
            payload.order.id,

          name:
            payload.order.name,

          financialStatus:
            payload.order
              .displayFinancialStatus,

          total:
            Number(
              payload.order
                .totalPriceSet
                .shopMoney
                .amount
            ),

          currency:
            payload.order
              .totalPriceSet
              .shopMoney
              .currencyCode
        },

        checkout: {
          paymentMethod:
            cleanString(
              payment.method
            ),

          subtotal:
            totals.subtotal,

          discount:
            totals.discountAmount,

          shipping:
            totals.shippingAmount,

          total:
            totals.total
        },

        message:
          'Prepaid payment verified and Shopify order created successfully.'
      };

      processedPrepaidPayments.set(
        razorpayPaymentId,
        result
      );

      return res.status(200).json(
        result
      );

    } catch (error) {
      console.error(
        'PREPAID VERIFY ERROR:',
        error
      );

      return res.status(400).json({
        success: false,

        orderCreated:
          false,

        message:
          error.message ||
          'Prepaid payment verification failed.'
      });
    }
  }
);

/* =========================================================
   404
========================================================= */

app.use(
  (req, res) => {
    res.status(404).json({
      success: false,
      message:
        'VYNIX endpoint not found.'
    });
  }
);

/* =========================================================
   GLOBAL ERROR HANDLER
========================================================= */

app.use(
  (
    error,
    req,
    res,
    next
  ) => {
    console.error(
      'GLOBAL ERROR:',
      error
    );

    if (
      res.headersSent
    ) {
      return next(error);
    }

    return res.status(500).json({
      success: false,

      message:
        error.message ||
        'Internal server error.'
    });
  }
);

/* =========================================================
   START SERVER
========================================================= */

app.listen(
  PORT,
  () => {
    console.log(
      `VYNIX CHECKOUT BACKEND RUNNING ON PORT ${PORT}`
    );

    console.log(
      'SHOPIFY STORE:',
      SHOPIFY_STORE_DOMAIN ||
        'NOT CONFIGURED'
    );

    console.log(
      'SHOPIFY API VERSION:',
      SHOPIFY_API_VERSION
    );

    console.log(
      'RAZORPAY:',
      razorpay
        ? 'CONFIGURED'
        : 'NOT CONFIGURED'
    );
  }
);
