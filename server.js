const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const Razorpay = require("razorpay");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

/* =========================================================
   CORS
========================================================= */

const allowedOrigins = [
  "https://www.vynix.co.in",
  "https://vynix.co.in"
];

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("CORS origin not allowed."));
      }
    }
  })
);

app.use(express.json({ limit: "1mb" }));

/* =========================================================
   ENVIRONMENT
========================================================= */

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;

const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

const SHOPIFY_API_VERSION = "2026-07";

const FREE_SHIPPING_THRESHOLD = 1499;
const SHIPPING_FEE = 35;

/* =========================================================
   RAZORPAY
========================================================= */

const razorpay =
  RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET
    ? new Razorpay({
        key_id: RAZORPAY_KEY_ID,
        key_secret: RAZORPAY_KEY_SECRET
      })
    : null;

/* =========================================================
   SHOPIFY TOKEN CACHE
========================================================= */

let shopifyToken = null;
let shopifyTokenExpiresAt = 0;

/* =========================================================
   BASIC HELPERS
========================================================= */

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
}

function normalizeCountryCode(country) {
  const value = String(country || "").trim();

  if (!value) return "IN";

  if (value.toLowerCase() === "india") {
    return "IN";
  }

  if (value.length === 2) {
    return value.toUpperCase();
  }

  return "IN";
}

function normalizeStateCode(state) {
  const value = String(state || "").trim();

  const map = {
    "andhra pradesh": "AP",
    "arunachal pradesh": "AR",
    assam: "AS",
    bihar: "BR",
    chhattisgarh: "CG",
    goa: "GA",
    gujarat: "GJ",
    haryana: "HR",
    "himachal pradesh": "HP",
    jharkhand: "JH",
    karnataka: "KA",
    kerala: "KL",
    "madhya pradesh": "MP",
    maharashtra: "MH",
    manipur: "MN",
    meghalaya: "ML",
    mizoram: "MZ",
    nagaland: "NL",
    odisha: "OR",
    punjab: "PB",
    rajasthan: "RJ",
    sikkim: "SK",
    "tamil nadu": "TN",
    telangana: "TS",
    tripura: "TR",
    "uttar pradesh": "UP",
    uttarakhand: "UK",
    "west bengal": "WB",
    delhi: "DL"
  };

  const lower = value.toLowerCase();

  return map[lower] || value;
}

function cleanVariantId(id) {
  const value = String(id || "").trim();

  if (!value) {
    return null;
  }

  if (value.startsWith("gid://shopify/ProductVariant/")) {
    return value;
  }

  if (/^\d+$/.test(value)) {
    return `gid://shopify/ProductVariant/${value}`;
  }

  return null;
}

/* =========================================================
   SHOPIFY CLIENT CREDENTIAL TOKEN
========================================================= */

async function getShopifyAccessToken() {
  if (
    shopifyToken &&
    Date.now() < shopifyTokenExpiresAt - 60 * 1000
  ) {
    return shopifyToken;
  }

  if (
    !SHOPIFY_STORE_DOMAIN ||
    !SHOPIFY_CLIENT_ID ||
    !SHOPIFY_CLIENT_SECRET
  ) {
    throw new Error("Shopify environment variables are missing.");
  }

  const response = await fetch(
    `https://${SHOPIFY_STORE_DOMAIN}/admin/oauth/access_token`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: SHOPIFY_CLIENT_ID,
        client_secret: SHOPIFY_CLIENT_SECRET
      })
    }
  );

  const data = await response.json();

  if (!response.ok || !data.access_token) {
    console.error("Shopify token error:", data);

    throw new Error(
      data.error_description ||
        data.error ||
        "Unable to authenticate with Shopify."
    );
  }

  shopifyToken = data.access_token;

  const expiresInSeconds = Number(data.expires_in || 86400);

  shopifyTokenExpiresAt =
    Date.now() + expiresInSeconds * 1000;

  return shopifyToken;
}

/* =========================================================
   SHOPIFY GRAPHQL
========================================================= */

async function shopifyGraphQL(query, variables = {}) {
  const token = await getShopifyAccessToken();

  const response = await fetch(
    `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token
      },
      body: JSON.stringify({
        query,
        variables
      })
    }
  );

  const data = await response.json();

  if (!response.ok) {
    console.error("Shopify HTTP error:", data);

    throw new Error(
      data.errors?.[0]?.message ||
        "Shopify API request failed."
    );
  }

  if (data.errors?.length) {
    console.error("Shopify GraphQL errors:", data.errors);

    throw new Error(
      data.errors[0].message ||
        "Shopify GraphQL request failed."
    );
  }

  return data.data;
}

/* =========================================================
   ROOT
========================================================= */

app.get("/", (req, res) => {
  res.json({
    success: true,
    service: "VYNIX Checkout Backend",
    status: "online"
  });
});

/* =========================================================
   HEALTH
========================================================= */

app.get("/health", async (req, res) => {
  res.json({
    success: true,
    service: "VYNIX Checkout Backend",
    status: "online",
    shopifyConfigured: Boolean(
      SHOPIFY_STORE_DOMAIN &&
        SHOPIFY_CLIENT_ID &&
        SHOPIFY_CLIENT_SECRET
    ),
    razorpayConfigured: Boolean(razorpay)
  });
});
/* =========================================================
   CHECKOUT WARM-UP
========================================================= */

app.get("/api/checkout/warmup", async (req, res) => {
  try {
    /*
      Wake the Render server and make sure the Shopify
      access token is already available before the customer
      clicks PLACE ORDER.
    */

    await getShopifyAccessToken();

    res.json({
      success: true,
      warmed: true,
      message: "VYNIX checkout is ready."
    });
  } catch (error) {
    console.error("Checkout warm-up error:", error);

    res.status(500).json({
      success: false,
      warmed: false,
      message: "Checkout warm-up failed."
    });
  }
});

/* =========================================================
   SHOPIFY TEST
========================================================= */

app.get("/api/test/shopify", async (req, res) => {
  try {
    const data = await shopifyGraphQL(`
      query {
        shop {
          name
          myshopifyDomain
          currencyCode
        }
      }
    `);

    res.json({
      success: true,
      shop: data.shop
    });
  } catch (error) {
    console.error("Shopify test error:", error);

    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

/* =========================================================
   RAZORPAY TEST
========================================================= */

app.post("/api/test/razorpay", async (req, res) => {
  try {
    if (!razorpay) {
      return res.status(500).json({
        success: false,
        message: "Razorpay is not configured."
      });
    }

    const amount = Number(req.body.amount);

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Amount must be greater than 0."
      });
    }

    const order = await razorpay.orders.create({
      amount: Math.round(amount * 100),
      currency: "INR",
      receipt: `vynix_test_${Date.now()}`,
      notes: {
        purpose: "VYNIX backend test"
      }
    });

    res.json({
      success: true,
      test: true,
      message: "Razorpay test order created successfully.",
      order: {
        id: order.id,
        amount: order.amount,
        currency: order.currency,
        status: order.status
      }
    });
  } catch (error) {
    console.error("Razorpay test error:", error);

    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

/* =========================================================
   VALIDATE CHECKOUT
========================================================= */

app.post("/api/checkout/validate", async (req, res) => {
  try {
    const {
      customer,
      shippingAddress,
      items,
      discountCode,
      paymentMethod
    } = req.body;

    if (!customer || !shippingAddress || !Array.isArray(items)) {
      return res.status(400).json({
        success: false,
        validated: false,
        message:
          "Customer, shipping address and items are required."
      });
    }

    if (!isValidEmail(customer.email)) {
      return res.status(400).json({
        success: false,
        validated: false,
        message: "A valid email address is required."
      });
    }

    if (!shippingAddress.address1) {
      return res.status(400).json({
        success: false,
        validated: false,
        message: "Shipping address is required."
      });
    }

    if (!shippingAddress.city) {
      return res.status(400).json({
        success: false,
        validated: false,
        message: "City is required."
      });
    }

    if (!shippingAddress.state) {
      return res.status(400).json({
        success: false,
        validated: false,
        message: "State is required."
      });
    }

    if (!shippingAddress.postalCode) {
      return res.status(400).json({
        success: false,
        validated: false,
        message: "Postal code is required."
      });
    }

    if (!items.length) {
      return res.status(400).json({
        success: false,
        validated: false,
        message: "Cart is empty."
      });
    }

    for (const item of items) {
      if (!cleanVariantId(item.variantId)) {
        return res.status(400).json({
          success: false,
          validated: false,
          message: "Invalid product variant."
        });
      }

      if (
        !Number.isInteger(Number(item.quantity)) ||
        Number(item.quantity) <= 0
      ) {
        return res.status(400).json({
          success: false,
          validated: false,
          message: "Invalid item quantity."
        });
      }
    }

    const allowedPaymentMethods = [
      "cod",
      "upi",
      "card",
      "wallet",
      "netbanking"
    ];

    if (!allowedPaymentMethods.includes(paymentMethod)) {
      return res.status(400).json({
        success: false,
        validated: false,
        message: "Invalid payment method."
      });
    }

    res.json({
      success: true,
      validated: true,
      message: "Checkout data received successfully.",
      checkout: {
        paymentMethod,
        itemCount: items.length,
        discountCodeProvided: Boolean(
          String(discountCode || "").trim()
        )
      }
    });
  } catch (error) {
    console.error("Validation error:", error);

    res.status(500).json({
      success: false,
      validated: false,
      message: "Unable to validate checkout."
    });
  }
});

/* =========================================================
   GET VARIANT PRICES
========================================================= */

async function getVariantDetails(items) {
  const ids = items.map((item) =>
    cleanVariantId(item.variantId)
  );

  const uniqueIds = [...new Set(ids)];

  const data = await shopifyGraphQL(
    `
      query GetVariants($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on ProductVariant {
            id
            title
            price
            product {
              title
            }
          }
        }
      }
    `,
    {
      ids: uniqueIds
    }
  );

  const variants = data.nodes || [];

  const variantMap = new Map();

  for (const variant of variants) {
    if (variant) {
      variantMap.set(variant.id, variant);
    }
  }

  const result = [];

  for (const item of items) {
    const variantId = cleanVariantId(item.variantId);
    const variant = variantMap.get(variantId);

    if (!variant) {
      throw new Error(
        `Product variant not found: ${variantId}`
      );
    }

    const quantity = Number(item.quantity);

    const unitPrice = Number(variant.price);

    if (!Number.isFinite(unitPrice)) {
      throw new Error(
        `Invalid price for variant: ${variantId}`
      );
    }

    result.push({
      variantId,
      quantity,
      unitPrice,
      title: variant.product?.title || variant.title || "Product"
    });
  }

  return result;
}

/* =========================================================
   DISCOUNT LOOKUP
========================================================= */

async function getDiscountCodeDetails(discountCode) {
  const code = String(discountCode || "")
    .trim()
    .toUpperCase();

  if (!code) {
    return null;
  }

  const data = await shopifyGraphQL(
    `
      query FindDiscount($query: String!) {
        discountNodes(
          first: 10
          query: $query
        ) {
          nodes {
            id
            discount {
              __typename

              ... on DiscountCodeBasic {
                title
                status
                startsAt
                endsAt

                codes(first: 20) {
                  nodes {
                    code
                  }
                }

                minimumRequirement {
                  ... on DiscountMinimumSubtotal {
                    greaterThanOrEqualToSubtotal {
                      amount
                      currencyCode
                    }
                  }

                  ... on DiscountMinimumQuantity {
                    greaterThanOrEqualToQuantity
                  }
                }

                customerGets {
                  value {
                    __typename

                    ... on DiscountPercentage {
                      percentage
                    }

                    ... on DiscountAmount {
                      amount {
                        amount
                        currencyCode
                      }
                    }
                  }

                  items {
                    __typename

                    ... on AllDiscountItems {
                      allItems
                    }
                  }
                }
              }
            }
          }
        }
      }
    `,
    {
      query: `code:${code}`
    }
  );

  const nodes = data.discountNodes?.nodes || [];

  for (const node of nodes) {
    const discount = node?.discount;

    if (!discount) continue;

    if (discount.__typename !== "DiscountCodeBasic") {
      continue;
    }

    const matchingCode = (discount.codes?.nodes || []).some(
      (entry) =>
        String(entry.code || "").toUpperCase() === code
    );

    if (!matchingCode) {
      continue;
    }

    return {
      id: node.id,
      ...discount
    };
  }

  return null;
}

/* =========================================================
   BUILD DISCOUNT INPUT
========================================================= */

function buildDiscountInput(discount) {
  if (!discount) {
    return null;
  }

  if (discount.status !== "ACTIVE") {
    throw new Error("This discount code is not active.");
  }

  const now = Date.now();

  if (discount.startsAt) {
    const startsAt = new Date(discount.startsAt).getTime();

    if (Number.isFinite(startsAt) && now < startsAt) {
      throw new Error("This discount code is not active yet.");
    }
  }

  if (discount.endsAt) {
    const endsAt = new Date(discount.endsAt).getTime();

    if (Number.isFinite(endsAt) && now > endsAt) {
      throw new Error("This discount code has expired.");
    }
  }

  if (
    !discount.customerGets?.items ||
    discount.customerGets.items.__typename !==
      "AllDiscountItems"
  ) {
    throw new Error(
      "This discount code is limited to specific products and cannot be used in this checkout yet."
    );
  }

  const value = discount.customerGets.value;

  if (!value) {
    throw new Error("Unable to read this discount code.");
  }

  if (value.__typename === "DiscountPercentage") {
    return {
      itemPercentageDiscountCode: {
        percentage: Number(value.percentage),
        code: discount.codes.nodes[0].code
      }
    };
  }

  if (value.__typename === "DiscountAmount") {
    return {
      itemFixedDiscountCode: {
        amountSet: {
          shopMoney: {
            amount: Number(value.amount.amount),
            currencyCode: "INR"
          }
        },
        code: discount.codes.nodes[0].code
      }
    };
  }

  throw new Error(
    "This discount type is not supported in this checkout yet."
  );
}

/* =========================================================
   CALCULATE BASIC DISCOUNT FOR SHIPPING THRESHOLD
========================================================= */

function calculateDiscountAmount(
  subtotal,
  discount,
  totalQuantity
) {
  if (!discount) {
    return 0;
  }

  const minimumRequirement =
    discount.minimumRequirement;

  if (minimumRequirement) {
    if (
      minimumRequirement.greaterThanOrEqualToQuantity !==
      undefined
    ) {
      const minimumQuantity = Number(
        minimumRequirement.greaterThanOrEqualToQuantity
      );

      if (totalQuantity < minimumQuantity) {
        throw new Error(
          `A minimum quantity of ${minimumQuantity} is required for this discount.`
        );
      }
    }

    if (
      minimumRequirement.greaterThanOrEqualToSubtotal
    ) {
      const minimumSubtotal = Number(
        minimumRequirement
          .greaterThanOrEqualToSubtotal
          .amount
      );

      if (subtotal < minimumSubtotal) {
        throw new Error(
          `A minimum order value of ₹${minimumSubtotal} is required for this discount.`
        );
      }
    }
  }

  const value = discount.customerGets?.value;

  if (!value) return 0;

  if (value.__typename === "DiscountPercentage") {
    const percentage = Number(value.percentage);

    return Math.min(
      subtotal,
      subtotal * percentage
    );
  }

  if (value.__typename === "DiscountAmount") {
    const amount = Number(value.amount.amount);

    return Math.min(subtotal, amount);
  }

  return 0;
}

/* =========================================================
   CREATE COD ORDER
========================================================= */

app.post("/api/checkout/cod", async (req, res) => {
  try {
    const {
      customer = {},
      shippingAddress = {},
      items = [],
      discountCode = ""
    } = req.body;

    /* -----------------------------------------------------
       BASIC VALIDATION
    ----------------------------------------------------- */

    if (!isValidEmail(customer.email)) {
      return res.status(400).json({
        success: false,
        orderCreated: false,
        message: "A valid email address is required."
      });
    }

    if (!shippingAddress.address1) {
      return res.status(400).json({
        success: false,
        orderCreated: false,
        message: "Shipping address is required."
      });
    }

    if (!shippingAddress.city) {
      return res.status(400).json({
        success: false,
        orderCreated: false,
        message: "City is required."
      });
    }

    if (!shippingAddress.state) {
      return res.status(400).json({
        success: false,
        orderCreated: false,
        message: "State is required."
      });
    }

    if (!shippingAddress.postalCode) {
      return res.status(400).json({
        success: false,
        orderCreated: false,
        message: "Postal code is required."
      });
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        orderCreated: false,
        message: "Cart is empty."
      });
    }

    /* -----------------------------------------------------
       GET REAL SHOPIFY VARIANT PRICES
    ----------------------------------------------------- */

    const variantDetails = await getVariantDetails(items);

    let subtotal = 0;
    let totalQuantity = 0;

    const lineItems = variantDetails.map((item) => {
      subtotal += item.unitPrice * item.quantity;
      totalQuantity += item.quantity;

      return {
        variantId: item.variantId,
        quantity: item.quantity
      };
    });

    subtotal = Number(subtotal.toFixed(2));

    /* -----------------------------------------------------
       DISCOUNT
    ----------------------------------------------------- */

    let discountDetails = null;
    let discountInput = null;
    let discountAmount = 0;

    const normalizedDiscountCode = String(
      discountCode || ""
    ).trim();

    if (normalizedDiscountCode) {
      discountDetails = await getDiscountCodeDetails(
        normalizedDiscountCode
      );

      if (!discountDetails) {
        return res.status(400).json({
          success: false,
          orderCreated: false,
          message: "Invalid discount code."
        });
      }

      discountInput =
        buildDiscountInput(discountDetails);

      discountAmount = Number(
        calculateDiscountAmount(
          subtotal,
          discountDetails,
          totalQuantity
        ).toFixed(2)
      );
    }

    /* -----------------------------------------------------
       SHIPPING
    ----------------------------------------------------- */

    const discountedMerchandiseSubtotal = Math.max(
      0,
      Number((subtotal - discountAmount).toFixed(2))
    );

    /*
      VYNIX shipping rule:
      ₹1499 or more = FREE
      below ₹1499 = ₹35

      We use the cart merchandise subtotal after the
      discount for this threshold.
    */

    const shippingAmount =
      discountedMerchandiseSubtotal >= FREE_SHIPPING_THRESHOLD
        ? 0
        : SHIPPING_FEE;

    /* -----------------------------------------------------
       SHOPIFY ORDER INPUT
    ----------------------------------------------------- */

    const firstName = String(
      customer.firstName || ""
    ).trim();

    const lastName = String(
      customer.lastName || ""
    ).trim();

    const phone = String(
      customer.phone || ""
    ).trim();

    const addressInput = {
      firstName: firstName || undefined,
      lastName: lastName || undefined,
      address1: String(
        shippingAddress.address1
      ).trim(),
      address2: String(
        shippingAddress.address2 || ""
      ).trim() || undefined,
      city: String(
        shippingAddress.city
      ).trim(),
      province: normalizeStateCode(
        shippingAddress.state
      ),
      countryCode: normalizeCountryCode(
        shippingAddress.country
      ),
      zip: String(
        shippingAddress.postalCode
      ).trim(),
      phone: phone || undefined
    };

    const orderInput = {
      lineItems,

      email: String(
        customer.email
      ).trim(),

      phone: phone || undefined,

      financialStatus: "PENDING",

      currency: "INR",

      presentmentCurrency: "INR",

      shippingAddress: addressInput,

      billingAddress: addressInput,

      shippingLines: [
        {
          title:
            shippingAmount === 0
              ? "FREE SHIPPING"
              : "Standard Shipping",
          priceSet: {
            shopMoney: {
              amount: shippingAmount,
              currencyCode: "INR"
            }
          }
        }
      ],

      note: "VYNIX Custom Checkout - Cash on Delivery",

      customAttributes: [
        {
          key: "Payment Method",
          value: "COD"
        },
        {
          key: "Checkout Source",
          value: "VYNIX Custom Checkout"
        }
      ],

      sourceName: "VYNIX Custom Checkout"
    };

    if (discountInput) {
      orderInput.discountCode = discountInput;
    }

    /*
      If the frontend supplies a Shopify customer GID,
      associate the order with that customer.
    */
    if (customer.id) {
      orderInput.customer = {
        toAssociate: {
          id: String(customer.id)
        }
      };
    }

    /* -----------------------------------------------------
       CREATE REAL SHOPIFY ORDER
    ----------------------------------------------------- */

    const mutation = `
      mutation CreateVynixCodOrder(
        $order: OrderCreateOrderInput!
      ) {
        orderCreate(order: $order) {
          userErrors {
            field
            message
          }

          order {
            id
            name
            displayFinancialStatus
            email
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

    const data = await shopifyGraphQL(
      mutation,
      {
        order: orderInput
      }
    );

    const result = data.orderCreate;

    if (result.userErrors?.length) {
      console.error(
        "Shopify orderCreate user errors:",
        result.userErrors
      );

      return res.status(400).json({
        success: false,
        orderCreated: false,
        message:
          result.userErrors
            .map((error) => error.message)
            .join(" "),
        errors: result.userErrors
      });
    }

    if (!result.order) {
      return res.status(500).json({
        success: false,
        orderCreated: false,
        message:
          "Shopify did not return a created order."
      });
    }

    /* -----------------------------------------------------
       SUCCESS
    ----------------------------------------------------- */

    console.log(
      `VYNIX COD order created: ${result.order.name}`
    );

    res.json({
      success: true,
      orderCreated: true,

      /*
        This is intentionally safe to expose to the
        frontend. No Shopify credentials are returned.
      */

      order: {
        id: result.order.id,
        name: result.order.name,
        financialStatus:
          result.order.displayFinancialStatus,
        total:
          result.order.totalPriceSet?.shopMoney?.amount ||
          null,
        currency:
          result.order.totalPriceSet?.shopMoney
            ?.currencyCode || "INR"
      },

      checkout: {
        paymentMethod: "cod",
        subtotal,
        discount: discountAmount,
        shipping: shippingAmount
      },

      message: "COD order created successfully."
    });
  } catch (error) {
    console.error(
      "COD checkout error:",
      error
    );

    res.status(500).json({
      success: false,
      orderCreated: false,
      message:
        error.message ||
        "Unable to create COD order."
    });
  }
});

/* =========================================================
   PREPAID PLACEHOLDERS
========================================================= */

app.post(
  "/api/checkout/prepaid/create",
  async (req, res) => {
    res.status(501).json({
      success: false,
      message:
        "Prepaid checkout is not implemented yet."
    });
  }
);

app.post(
  "/api/checkout/prepaid/verify",
  async (req, res) => {
    res.status(501).json({
      success: false,
      message:
        "Prepaid payment verification is not implemented yet."
    });
  }
);

/* =========================================================
   404
========================================================= */

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Endpoint not found."
  });
});

/* =========================================================
   GLOBAL ERROR HANDLER
========================================================= */

app.use((error, req, res, next) => {
  console.error("Unhandled server error:", error);

  if (res.headersSent) {
    return next(error);
  }

  res.status(500).json({
    success: false,
    message: "Internal server error."
  });
});

/* =========================================================
   START SERVER
========================================================= */

app.listen(PORT, () => {
  console.log(
    `VYNIX Checkout Backend running on port ${PORT}`
  );
});
