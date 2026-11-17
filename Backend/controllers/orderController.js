import { createHmac, timingSafeEqual } from "node:crypto";
import orderModel from "../models/orderModel.js";
import userModel from "../models/userModel.js";
import productModel from "../models/productModel.js";

// placing order using COD method
export const placeOrder = async (req, res) => {
  try {
    const userId = req.userId; // ← use middleware value
    const { items, amount, address } = req.body;

    console.log("Received Order Data:", { userId, items, amount, address });

    if (!items || items.length === 0) {
      return res.json({ success: false, message: "No items in the order" });
    }

    const orderData = {
      userId,
      items,
      amount,
      address,
      paymentMethod: "COD",
      payment: false,
      status: "pending",
      date: Date.now(),
    };

    const newOrder = await orderModel.create(orderData);
    console.log("Order created:", newOrder);

    // clear user's cart
    await userModel.findByIdAndUpdate(userId, { cartData: {} });

    res.json({ success: true, message: "Order placed", order: newOrder });
  } catch (error) {
    console.log(error);
    res.json({ success: false, message: error.message });
  }
};

const ESEWA_DELIVERY_FEE = 100;
const ESEWA_SIGNED_FIELDS =
  "transaction_code,status,total_amount,transaction_uuid,product_code,signed_field_names";

const getEsewaConfig = () => ({
  secret: String(process.env.ESEWA_SECRET_KEY || "").trim(),
  productCode: String(process.env.ESEWA_PRODUCT_CODE || "").trim(),
  gatewayUrl: (
    process.env.ESEWA_GATEWAY_URL || "https://rc-epay.esewa.com.np"
  ).replace(/\/$/, ""),
});

const signEsewaFields = (fields, secret) =>
  createHmac("sha256", secret).update(fields).digest("base64");

const toEsewaPaisa = (amount) => Math.round(Number(amount) * 100);

export const initiateEsewaPayment = async (req, res) => {
  try {
    const userId = req.userId;
    const { items, address } = req.body;
    const { secret, productCode, gatewayUrl } = getEsewaConfig();

    if (!secret || !productCode) {
      return res.status(500).json({
        success: false,
        message:
          "Configure ESEWA_SECRET_KEY and ESEWA_PRODUCT_CODE in Backend/.env.",
      });
    }

    if (
      !Array.isArray(items) ||
      items.length === 0 ||
      items.some(
        (item) =>
          !item ||
          !/^[a-f\d]{24}$/i.test(String(item._id)) ||
          !Number.isSafeInteger(Number(item.quantity)) ||
          Number(item.quantity) < 1
      )
    ) {
      return res.status(400).json({
        success: false,
        message: "Order must contain valid product IDs and quantities.",
      });
    }

    const productIds = items.map((item) => String(item._id));
    if (new Set(productIds).size !== productIds.length) {
      return res.status(400).json({
        success: false,
        message: "Order contains duplicate products.",
      });
    }

    const products = await productModel
      .find({ _id: { $in: productIds } })
      .select("name price image")
      .lean();
    if (products.length !== productIds.length) {
      return res.status(400).json({
        success: false,
        message: "One or more products are no longer available.",
      });
    }

    const productsById = new Map(
      products.map((product) => [String(product._id), product])
    );
    const orderItems = items.map((item) => {
      const product = productsById.get(String(item._id));
      return {
        _id: String(product._id),
        name: product.name,
        price: product.price,
        image: product.image,
        quantity: Number(item.quantity),
      };
    });

    const itemsAmountPaisa = orderItems.reduce(
      (total, item) => total + toEsewaPaisa(item.price) * item.quantity,
      0
    );
    const totalAmountPaisa =
      itemsAmountPaisa + toEsewaPaisa(ESEWA_DELIVERY_FEE);
    if (
      !Number.isSafeInteger(totalAmountPaisa) ||
      totalAmountPaisa <= 0 ||
      orderItems.some((item) => !Number.isSafeInteger(toEsewaPaisa(item.price)))
    ) {
      return res.status(400).json({
        success: false,
        message: "The order amount is invalid.",
      });
    }

    const frontendUrl = (
      process.env.FRONTEND_URL || "http://localhost:5173"
    ).replace(/\/$/, "");
    const totalAmount = (totalAmountPaisa / 100).toFixed(2);
    const order = await orderModel.create({
      userId,
      items: orderItems,
      amount: Number(totalAmount),
      address,
      paymentMethod: "Esewa",
      payment: false,
      status: "Esewa Pending",
      date: Date.now(),
    });

    const transactionUuid = order._id.toString();
    const signedFields = `total_amount=${totalAmount},transaction_uuid=${transactionUuid},product_code=${productCode}`;
    const payment = {
      amount: (itemsAmountPaisa / 100).toFixed(2),
      tax_amount: "0",
      total_amount: totalAmount,
      transaction_uuid: transactionUuid,
      product_code: productCode,
      product_service_charge: "0",
      product_delivery_charge: ESEWA_DELIVERY_FEE.toFixed(2),
      success_url: new URL("/payment/esewa-return", frontendUrl).toString(),
      failure_url: new URL(
        "/payment/esewa-return?status=failed",
        frontendUrl
      ).toString(),
      signed_field_names: "total_amount,transaction_uuid,product_code",
      signature: signEsewaFields(signedFields, secret),
    };

    return res.json({
      success: true,
      payment_url: `${gatewayUrl}/api/epay/main/v2/form`,
      payment,
      orderId: transactionUuid,
    });
  } catch (error) {
    console.log(error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const verifyEsewaPayment = async (req, res) => {
  try {
    const userId = String(req.userId);
    const { data } = req.body;
    const { secret, productCode, gatewayUrl } = getEsewaConfig();
    if (!secret || !productCode) {
      return res.status(500).json({
        success: false,
        message:
          "Configure ESEWA_SECRET_KEY and ESEWA_PRODUCT_CODE in Backend/.env.",
      });
    }
    if (typeof data !== "string" || !data) {
      return res.status(400).json({
        success: false,
        message: "Missing eSewa payment response.",
      });
    }

    let decoded;
    try {
      decoded = JSON.parse(Buffer.from(data, "base64").toString("utf8"));
    } catch {
      return res.status(400).json({
        success: false,
        message: "Invalid eSewa payment response.",
      });
    }

    const signedFieldNames = decoded.signed_field_names;
    const signedFields =
      typeof signedFieldNames === "string" ? signedFieldNames.split(",") : [];
    if (
      signedFieldNames !== ESEWA_SIGNED_FIELDS ||
      signedFields.some((field) => typeof decoded[field] !== "string") ||
      typeof decoded.signature !== "string" ||
      decoded.product_code !== productCode ||
      decoded.status !== "COMPLETE" ||
      !/^[a-f\d]{24}$/i.test(String(decoded.transaction_uuid))
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid or incomplete eSewa payment response.",
      });
    }

    const signedData = signedFields
      .map((field) => `${field}=${decoded[field]}`)
      .join(",");
    const expectedSignature = signEsewaFields(signedData, secret);
    const receivedSignature = Buffer.from(decoded.signature);
    const expectedSignatureBuffer = Buffer.from(expectedSignature);
    if (
      receivedSignature.length !== expectedSignatureBuffer.length ||
      !timingSafeEqual(receivedSignature, expectedSignatureBuffer)
    ) {
      return res.status(400).json({
        success: false,
        message: "eSewa response signature is invalid.",
      });
    }

    const order = await orderModel.findById(decoded.transaction_uuid);
    if (
      !order ||
      String(order.userId) !== userId ||
      order.paymentMethod !== "Esewa"
    ) {
      return res.status(404).json({ success: false, message: "Order not found." });
    }

    const expectedAmountPaisa = toEsewaPaisa(order.amount);
    if (toEsewaPaisa(decoded.total_amount) !== expectedAmountPaisa) {
      return res.status(400).json({
        success: false,
        message: "Payment amount does not match the order.",
      });
    }

    if (order.payment) {
      return res.json({
        success: true,
        message: "Order already confirmed.",
        order,
      });
    }

    const statusUrl = new URL(
      "/api/epay/transaction/status/",
      `${gatewayUrl}/`
    );
    statusUrl.search = new URLSearchParams({
      product_code: productCode,
      total_amount: (expectedAmountPaisa / 100).toFixed(2),
      transaction_uuid: order._id.toString(),
    }).toString();

    const statusResponse = await fetch(statusUrl, {
      headers: { Accept: "application/json" },
    });
    const statusText = await statusResponse.text();
    let paymentStatus;
    try {
      paymentStatus = statusText ? JSON.parse(statusText) : {};
    } catch {
      return res.status(502).json({
        success: false,
        message: "Invalid response from eSewa transaction verification.",
      });
    }

    if (!statusResponse.ok) {
      return res.status(502).json({
        success: false,
        message:
          paymentStatus.message || "Could not verify the payment with eSewa.",
      });
    }

    if (
      paymentStatus.status !== "COMPLETE" ||
      paymentStatus.transaction_uuid !== order._id.toString() ||
      paymentStatus.product_code !== productCode ||
      toEsewaPaisa(paymentStatus.total_amount) !== expectedAmountPaisa
    ) {
      return res.status(400).json({
        success: false,
        message: paymentStatus.status || "eSewa payment is not complete.",
      });
    }

    await orderModel.findByIdAndUpdate(order._id, {
      payment: true,
      status: "OrderPlaced",
      paymentDetails: {
        transaction_code: decoded.transaction_code,
        status: paymentStatus.status,
        total_amount: paymentStatus.total_amount,
        transaction_uuid: order._id.toString(),
        product_code: productCode,
        ref_id: paymentStatus.ref_id,
      },
    });
    await userModel.findByIdAndUpdate(userId, { cartData: {} });

    const updatedOrder = await orderModel.findById(order._id);
    return res.json({
      success: true,
      message: "Payment verified.",
      order: updatedOrder,
    });
  } catch (error) {
    console.log(error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// all orders for admin panel
export const allOrder = async (req, res) => {
  try {
    const orders = await orderModel.find({});
    res.json({ success: true, orders });
  } catch (error) {
    console.log(error);
    res.json({ success: false, message: error.message });
  }
};

// user orders for frontend
export const userOrders = async (req, res) => {
  try {
    const userId = req.userId; // ← use middleware value
    console.log("Fetching orders for userId:", userId);

    const orders = await orderModel.find({ userId }).sort({ date: -1 });
    console.log("Orders found:", orders);

    if (orders.length === 0) {
      return res.json({
        success: true,
        message: "No orders found",
        orders: [],
      });
    }

    res.json({ success: true, orders });
  } catch (error) {
    console.log(error);
    res.json({ success: false, message: error.message });
  }
};

// update order status from admin panel
export const updateStatus = async (req, res) => {
  try {
    const { orderId, status } = req.body;
    await orderModel.findByIdAndUpdate(orderId, { status });

    res.json({ success: true, message: "Status updated" });
  } catch (error) {
    console.log(error);
    res.json({ success: false, message: error.message });
  }
};

// delete completed/delivered order from admin panel
export const deleteOrder = async (req, res) => {
  try {
    const { id } = req.params;

    const order = await orderModel.findById(id);

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    // Only allow deletion for completed/delivered orders
    if (order.status !== "Delivered" && order.status !== "completed") {
      return res.status(400).json({
        success: false,
        message: "Only delivered/completed orders can be deleted",
      });
    }

    await orderModel.findByIdAndDelete(id);

    res.json({
      success: true,
      message: "Order deleted successfully",
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// Khalti ePayment (KPG-2)
// https://docs.khalti.com/khalti-epayment/
// Sandbox: POST https://dev.khalti.com/api/v2/epayment/initiate/
// Lookup:  POST https://dev.khalti.com/api/v2/epayment/lookup/
const getKhaltiBaseUrl = () =>
  (process.env.KHALTI_API_URL || "https://dev.khalti.com/api/v2").replace(
    /\/$/,
    ""
  );

/** Docs: amount is in paisa. Rs 10 = 1000 paisa, and that is the minimum. */
const nprToPaisa = (npr) => Math.round(Number(npr) * 100);
const DELIVERY_FEE_PAISA = 10000;

const khaltiErrorMessage = (data, status) => {
  if (!data || typeof data !== "object") {
    return `Khalti error (${status})`;
  }
  if (typeof data.detail === "string") return data.detail;
  const fieldErrors = Object.entries(data)
    .filter(([key]) => key !== "error_key" && key !== "status_code")
    .map(([key, value]) => {
      const text = Array.isArray(value) ? value.join(", ") : String(value);
      return `${key}: ${text}`;
    });
  return fieldErrors[0] || data.error_key || `Khalti error (${status})`;
};

const khaltiRequest = async (path, body) => {
  const secret = String(process.env.KHALTI_SECRET_KEY || "").trim();
  if (!secret) {
    return {
      ok: false,
      status: 500,
      data: {
        detail:
          "Add KHALTI_SECRET_KEY to Backend/.env from https://test-admin.khalti.com (sandbox live secret key), then restart the backend.",
      },
    };
  }

  const url = `${getKhaltiBaseUrl()}${path}`;
  // Official curl samples use "key <secret>". Some dashboard text says "Key".
  const send = (prefix) =>
    fetch(url, {
      method: "POST",
      headers: {
        Authorization: `${prefix} ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

  let response = await send("key");
  if (response.status === 401) {
    response = await send("Key");
  }

  const raw = await response.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { detail: raw.slice(0, 200) || "Invalid response from Khalti" };
  }

  return { ok: response.ok, status: response.status, data };
};

export const initiateKhaltiPayment = async (req, res) => {
  try {
    const userId = req.userId;
    const { items, address } = req.body;

    if (
      !Array.isArray(items) ||
      items.length === 0 ||
      items.some(
        (item) =>
          !item ||
          !/^[a-f\d]{24}$/i.test(String(item._id)) ||
          !Number.isSafeInteger(Number(item.quantity)) ||
          Number(item.quantity) < 1
      )
    ) {
      return res.status(400).json({
        success: false,
        message: "Order must contain valid product IDs and quantities.",
      });
    }

    const productIds = items.map((item) => String(item._id));
    if (new Set(productIds).size !== productIds.length) {
      return res.status(400).json({
        success: false,
        message: "Order contains duplicate products.",
      });
    }

    const products = await productModel
      .find({ _id: { $in: productIds } })
      .select("name price image")
      .lean();
    if (products.length !== productIds.length) {
      return res.status(400).json({
        success: false,
        message: "One or more products are no longer available.",
      });
    }

    const productsById = new Map(
      products.map((product) => [String(product._id), product])
    );
    const orderItems = items.map((item) => {
      const product = productsById.get(String(item._id));
      return {
        _id: String(product._id),
        name: product.name,
        price: product.price,
        image: product.image,
        quantity: Number(item.quantity),
      };
    });

    const itemsAmountPaisa = orderItems.reduce(
      (total, item) => total + nprToPaisa(item.price) * item.quantity,
      0
    );
    const amountPaisa = itemsAmountPaisa + DELIVERY_FEE_PAISA;
    if (!Number.isSafeInteger(amountPaisa) || amountPaisa < 1000) {
      return res.status(400).json({
        success: false,
        message: "The order amount is invalid.",
      });
    }

    const frontendUrl = (
      process.env.FRONTEND_URL || "http://localhost:5173"
    ).replace(/\/$/, "");

    const phoneDigits = String(address?.phone || "").replace(/\D/g, "");
    const phone =
      phoneDigits.length >= 10 ? phoneDigits.slice(-10) : "9800000001";

    const order = await orderModel.create({
      userId,
      items: orderItems,
      amount: amountPaisa / 100,
      address,
      paymentMethod: "Khalti",
      payment: false,
      status: "Khalti Pending",
      date: Date.now(),
    });

    const purchaseOrderId = order._id.toString();
    const payload = {
      return_url: `${frontendUrl}/payment/khalti-return`,
      website_url: frontendUrl,
      amount: amountPaisa,
      purchase_order_id: purchaseOrderId,
      purchase_order_name:
        orderItems.length === 1
          ? String(orderItems[0].name || "Order").slice(0, 120)
          : `Order (${orderItems.length} items)`,
      customer_info: {
        name: `${address?.firstName || ""} ${address?.lastName || ""}`.trim(),
        email: address?.email,
        phone,
      },
      amount_breakdown: [
        { label: "Items", amount: itemsAmountPaisa },
        { label: "Delivery", amount: DELIVERY_FEE_PAISA },
      ],
      product_details: orderItems.map((item) => {
        const unitPrice = nprToPaisa(item.price);
        const quantity = item.quantity;
        return {
          identity: String(item._id || item.name || "item"),
          name: String(item.name || "Product").slice(0, 100),
          unit_price: unitPrice,
          quantity,
          total_price: unitPrice * quantity,
        };
      }),
    };

    const { ok, status, data } = await khaltiRequest(
      "/epayment/initiate/",
      payload
    );

    if (!ok || !data.payment_url || !data.pidx) {
      await orderModel.findByIdAndDelete(order._id);
      return res.json({
        success: false,
        message: khaltiErrorMessage(data, status),
      });
    }

    await orderModel.findByIdAndUpdate(order._id, {
      khaltiPidx: data.pidx,
    });

    return res.json({
      success: true,
      payment_url: data.payment_url,
      pidx: data.pidx,
      orderId: purchaseOrderId,
    });
  } catch (error) {
    console.log(error);
    res.json({ success: false, message: error.message });
  }
};

export const verifyKhaltiPayment = async (req, res) => {
  try {
    const userId = String(req.userId);
    const { pidx, orderId } = req.body;

    if (!pidx || !orderId) {
      return res.json({
        success: false,
        message: "pidx and orderId are required",
      });
    }

    const order = await orderModel.findById(orderId);
    if (!order || String(order.userId) !== userId) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    if (String(order.khaltiPidx) !== String(pidx)) {
      return res.status(400).json({
        success: false,
        message: "Payment ID does not match this order.",
      });
    }

    if (order.payment) {
      return res.json({
        success: true,
        message: "Order already confirmed",
        order,
      });
    }

    // Docs: never trust the redirect alone. Confirm with /epayment/lookup/.
    const { ok, status, data: lookup } = await khaltiRequest(
      "/epayment/lookup/",
      { pidx }
    );

    if (!ok || lookup.pidx !== pidx || lookup.status !== "Completed") {
      await orderModel.findByIdAndUpdate(orderId, {
        status:
          lookup.status === "Completed"
            ? "Khalti Pending"
            : lookup.status || "Khalti Pending",
        payment: false,
        paymentDetails: { pidx, lookup },
      });
      return res.json({
        success: false,
        message: lookup.status || khaltiErrorMessage(lookup, status),
      });
    }

    const expectedPaisa = nprToPaisa(order.amount);
    if (Number(lookup.total_amount) !== expectedPaisa) {
      return res.json({
        success: false,
        message: "Amount mismatch with order",
        lookup,
      });
    }

    await orderModel.findByIdAndUpdate(orderId, {
      payment: true,
      status: "OrderPlaced",
      paymentDetails: {
        pidx,
        transaction_id: lookup.transaction_id,
        fee: lookup.fee,
        lookup,
      },
    });

    await userModel.findByIdAndUpdate(userId, { cartData: {} });

    const updated = await orderModel.findById(orderId);
    return res.json({
      success: true,
      message: "Payment verified",
      order: updated,
    });
  } catch (error) {
    console.log(error);
    res.json({ success: false, message: error.message });
  }
};