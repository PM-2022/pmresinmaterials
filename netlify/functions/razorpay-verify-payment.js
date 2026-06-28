/**
 * Verifies Razorpay signature and marks the Supabase order Confirmed (service role).
 * Env: RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * Body JSON: { razorpay_order_id, razorpay_payment_id, razorpay_signature }
 */
const crypto = require('crypto');

function escLines(s) {
  return String(s == null ? '' : s);
}

function supaHeaders(serviceKey, extra) {
  return {
    Authorization: `Bearer ${serviceKey}`,
    apikey: serviceKey,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
    ...extra,
  };
}

function parseVariants(raw) {
  if (raw == null || raw === '') return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const j = JSON.parse(raw);
      return Array.isArray(j) ? j : [];
    } catch {
      return [];
    }
  }
  return [];
}

function variantAggregate(variants) {
  let stockSum = 0;
  let inStock = false;
  for (const v of variants) {
    const sq = Math.max(0, Math.floor(Number(v.stockQty) || 0));
    stockSum += sq;
    if (sq > 0) inStock = true;
  }
  return { stock_qty: stockSum, in_stock: inStock };
}

/**
 * Decrement inventory after verified payment (service role; shoppers are not admin).
 */
async function deductStockForPaidOrder(supabaseUrl, serviceKey, orderId) {
  const base = `${supabaseUrl}/rest/v1`;
  const hdr = supaHeaders(serviceKey, { Prefer: 'return=minimal' });
  const itemsRes = await fetch(
    `${base}/order_items?order_id=eq.${encodeURIComponent(orderId)}&select=product_id,qty,variant_label`,
    { headers: hdr }
  );
  if (!itemsRes.ok) {
    return { ok: false, detail: await itemsRes.text() };
  }
  const items = await itemsRes.json().catch(function () {
    return [];
  });
  if (!Array.isArray(items) || !items.length) return { ok: true };

  for (const row of items) {
    const pid = row.product_id != null ? String(row.product_id).trim() : '';
    const q = Math.max(0, Math.floor(Number(row.qty) || 0));
    const vlabel = row.variant_label != null ? String(row.variant_label).trim() : '';
    if (!pid || q <= 0) continue;

    const prodRes = await fetch(`${base}/products?id=eq.${encodeURIComponent(pid)}&select=id,stock_qty,in_stock,variants`, {
      headers: hdr,
    });
    if (!prodRes.ok) continue;
    const prows = await prodRes.json().catch(function () {
      return [];
    });
    const p = prows && prows[0];
    if (!p) continue;

    let variants = parseVariants(p.variants);
    let patch;

    if (variants.length > 0 && vlabel) {
      const vi = variants.findIndex(function (v) {
        return String(v.label || '').trim() === vlabel;
      });
      if (vi >= 0) {
        const cur = Math.max(0, Math.floor(Number(variants[vi].stockQty) || 0));
        variants[vi].stockQty = Math.max(0, cur - q);
      }
      const agg = variantAggregate(variants);
      patch = { stock_qty: agg.stock_qty, in_stock: agg.in_stock, variants: variants };
    } else {
      const curSq = Math.max(0, Math.floor(Number(p.stock_qty) || 0));
      const nextSq = Math.max(0, curSq - q);
      patch = { stock_qty: nextSq, in_stock: nextSq > 0 };
    }

    let up = await fetch(`${base}/products?id=eq.${encodeURIComponent(pid)}`, {
      method: 'PATCH',
      headers: hdr,
      body: JSON.stringify(patch),
    });
    if (!up.ok && patch.variants) {
      delete patch.variants;
      up = await fetch(`${base}/products?id=eq.${encodeURIComponent(pid)}`, {
        method: 'PATCH',
        headers: hdr,
        body: JSON.stringify(patch),
      });
    }
    if (!up.ok) {
      return { ok: false, detail: (await up.text()).slice(0, 300) };
    }
  }
  return { ok: true };
}

async function sendEmailJsTemplate({
  serviceId,
  templateId,
  publicKey,
  templateParams,
}) {
  if (!serviceId || !templateId || !publicKey) {
    return { ok: false, detail: 'EmailJS env missing' };
  }
  const res = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      service_id: serviceId,
      template_id: templateId,
      user_id: publicKey,
      template_params: templateParams || {},
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(function () { return ''; });
    return { ok: false, detail: t.slice(0, 500) || 'EmailJS send failed' };
  }
  return { ok: true };
}

async function fetchOrderWithItems(supabaseUrl, serviceKey, orderId) {
  const base = `${supabaseUrl}/rest/v1`;
  const hdr = supaHeaders(serviceKey, { Prefer: 'return=minimal' });
  const oRes = await fetch(
    `${base}/orders?id=eq.${encodeURIComponent(orderId)}&select=id,customer,subtotal,total,shipping_amount,status,payment_method,payment_label,payment_reference,created_at`,
    { headers: hdr }
  );
  if (!oRes.ok) return { ok: false, detail: (await oRes.text()).slice(0, 500) };
  const oRows = await oRes.json().catch(function () { return []; });
  const o = oRows && oRows[0];
  if (!o) return { ok: false, detail: 'Order not found in Supabase' };

  const iRes = await fetch(
    `${base}/order_items?order_id=eq.${encodeURIComponent(orderId)}&select=name,price,qty,variant_label`,
    { headers: hdr }
  );
  if (!iRes.ok) return { ok: false, detail: (await iRes.text()).slice(0, 500) };
  const items = await iRes.json().catch(function () { return []; });
  return { ok: true, order: o, items: Array.isArray(items) ? items : [] };
}

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  const supabaseUrl = (process.env.SUPABASE_URL || process.env.RRM_SUPABASE_URL || '').replace(/\/$/, '');
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return {
      statusCode: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid JSON' }),
    };
  }

  const razorpay_order_id = payload.razorpay_order_id;
  const razorpay_payment_id = payload.razorpay_payment_id;
  const razorpay_signature = payload.razorpay_signature;

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return {
      statusCode: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Missing razorpay_order_id, razorpay_payment_id, or razorpay_signature' }),
    };
  }

  if (!keySecret) {
    return {
      statusCode: 503,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Razorpay secret not configured' }),
    };
  }

  const signInput = razorpay_order_id + '|' + razorpay_payment_id;
  const expected = crypto.createHmac('sha256', keySecret).update(signInput).digest('hex');
  if (expected !== razorpay_signature) {
    return {
      statusCode: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid payment signature' }),
    };
  }

  if (!keyId) {
    return {
      statusCode: 503,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Razorpay key id not configured' }),
    };
  }

  const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
  const ordRes = await fetch(`https://api.razorpay.com/v1/orders/${encodeURIComponent(razorpay_order_id)}`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  const ord = await ordRes.json().catch(function () {
    return {};
  });
  const siteOrderId = ord.notes && ord.notes.site_order_id;
  if (!siteOrderId) {
    return {
      statusCode: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Could not resolve site order from Razorpay order' }),
    };
  }

  if (!supabaseUrl || !serviceKey) {
    return {
      statusCode: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ok: true,
        siteOrderId,
        warning: 'SUPABASE_SERVICE_ROLE_KEY or SUPABASE_URL missing — order not updated in database',
      }),
    };
  }

  const patchRes = await fetch(
    `${supabaseUrl}/rest/v1/orders?id=eq.${encodeURIComponent(siteOrderId)}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        apikey: serviceKey,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        status: 'Confirmed',
        payment_label: 'Razorpay',
        payment_method: 'razorpay',
        payment_reference: razorpay_payment_id,
      }),
    }
  );

  if (!patchRes.ok) {
    const detail = await patchRes.text();
    return {
      statusCode: 502,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Failed to update order', detail: detail.slice(0, 500) }),
    };
  }

  const stockRes = await deductStockForPaidOrder(supabaseUrl, serviceKey, siteOrderId);
  if (!stockRes.ok) {
    console.warn('deductStockForPaidOrder', siteOrderId, stockRes.detail);
  }

  // Server-side emails (so customer can close the tab)
  const emailjsPublicKey = process.env.EMAILJS_PUBLIC_KEY;
  const emailjsServiceId = process.env.EMAILJS_SERVICE_ID;
  const emailjsTplMerchant = process.env.EMAILJS_TEMPLATE_ORDER;
  const emailjsTplCustomer = process.env.EMAILJS_TEMPLATE_ORDER_CONFIRM;
  const merchantEmail = process.env.MERCHANT_NOTIFY_EMAIL || 'preservingmemories2022@gmail.com';
  let serverEmailsSent = false;
  let emailWarning = '';

  if (emailjsPublicKey && emailjsServiceId && (emailjsTplMerchant || emailjsTplCustomer)) {
    const ord = await fetchOrderWithItems(supabaseUrl, serviceKey, siteOrderId);
    if (!ord.ok) {
      emailWarning = 'Could not load order for email';
      console.warn('fetchOrderWithItems', siteOrderId, ord.detail);
    } else {
      const o = ord.order;
      const c = (o.customer && typeof o.customer === 'object') ? o.customer : {};
      const items = ord.items || [];
      const lines = items
        .map(function (i) {
          const nm = i && i.name ? String(i.name) : 'Item';
          const q2 = Math.max(0, Math.floor(Number(i.qty) || 0));
          const pr = Number(i.price) || 0;
          return nm + ' ×' + q2 + ' — ₹' + (pr * q2);
        })
        .join('\n');

      const common = {
        merchant_email: merchantEmail,
        order_id: String(o.id),
        customer_name: c.name || '—',
        phone: c.phone || '—',
        email: c.email || '',
        to_email: c.email || '',
        address: c.address || [c.address1, c.city, c.state, c.pin].filter(Boolean).join(', '),
        payment: o.payment_method || 'razorpay',
        total: String(o.total != null ? o.total : ''),
        subtotal: String(o.subtotal != null ? o.subtotal : ''),
        discount_amount: String(c.discount_amount != null ? c.discount_amount : 0),
        coupon_code: (c.coupon_code && String(c.coupon_code).trim()) ? String(c.coupon_code).trim() : '—',
        shipping_amount: String(o.shipping_amount != null ? o.shipping_amount : 0),
        payment_reference: o.payment_reference || razorpay_payment_id,
        order_status: String(o.status || 'Confirmed'),
        items_detail: escLines(lines),
        reply_to: (c.email && String(c.email).trim()) ? String(c.email).trim() : merchantEmail,
        store_url: process.env.STORE_URL || '',
        store_name: 'Preserving Memories Resin Materials',
      };

      const merchantOk = emailjsTplMerchant
        ? await sendEmailJsTemplate({
            serviceId: emailjsServiceId,
            templateId: emailjsTplMerchant,
            publicKey: emailjsPublicKey,
            templateParams: common,
          })
        : { ok: true };

      const custOk = (emailjsTplCustomer && common.to_email)
        ? await sendEmailJsTemplate({
            serviceId: emailjsServiceId,
            templateId: emailjsTplCustomer,
            publicKey: emailjsPublicKey,
            templateParams: common,
          })
        : { ok: true };

      serverEmailsSent = !!(merchantOk.ok && custOk.ok);
      if (!merchantOk.ok || !custOk.ok) {
        emailWarning = 'Email send failed';
        console.warn('EmailJS merchant', merchantOk);
        console.warn('EmailJS customer', custOk);
      }
    }
  }

  return {
    statusCode: 200,
    headers: { ...cors, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ok: true,
      siteOrderId,
      stockDeductionOk: stockRes.ok,
      serverEmailsSent: serverEmailsSent,
      ...(stockRes.ok ? {} : { stockWarning: 'Order confirmed but inventory update failed — check products / order_items.' }),
      ...(emailWarning ? { emailWarning: emailWarning } : {}),
    }),
  };
};
