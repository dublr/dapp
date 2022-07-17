
import { ethers } from "ethers";
import { dataflow } from "./dataflow-lib.js";

// Orderbook charting ------------------------------------------------------------------

let depthChartCanvas = document.getElementById("depthChartCanvas");
let canvasVerts = [];
let mouseOverVert = undefined;

function toNumber(bigNum) {
    if (bigNum === undefined) {
        return undefined;
    }
    let num = Number.parseFloat(bigNum.toString());
    if (isNaN(num)) {
        try {
            num = bigNum.toNumber();
        } catch (e) {
            // Fall through
        }
    }
    return isNaN(num) ? undefined : num;
}

// Scale the canvas to the size of its container
// (requires canvas to have style="width: 100%; height: 100%")
function fitToContainer(canvas) {
  // Set the bitmap size of the canvas to match the display size
  canvas.width = canvas.offsetWidth;
  canvas.height = canvas.offsetHeight;
  // Update chart
  drawDepthChart();
}

// Draw depth chart
export function drawDepthChart() {
    canvasVerts = [];
    if (!depthChartCanvas) {
        return;
    }
    const ctx = depthChartCanvas.getContext("2d");
    // Clear canvas
    ctx.clearRect(0, 0, depthChartCanvas.width, depthChartCanvas.height);
    // For speed, don't wait for dataflow to end via dataflow.get("orderbook"), just get latest value
    const orderbook = dataflow.value.orderbook;
    if (!orderbook || orderbook.length === 0) {
        return;
    }
    
    // Get mint price
    let mintPriceNWCPerDUBLR_x1e9;
    for (const order of orderbook) {
        if (order.isMintPriceEntry) {
            mintPriceNWCPerDUBLR_x1e9 = order.priceNWCPerDUBLR_x1e9;
            break;
        }
    }
        
    // Clamp display price to a large multiple of mint price, to prevent chart getting egregiously stretched
    // by high list prices
    let maxDisplayablePrice = mintPriceNWCPerDUBLR_x1e9 ? mintPriceNWCPerDUBLR_x1e9.mul(10) : undefined;
    // TODO also ensure mint price is not more than 10x greater than the most expensive orderbook order
    
    // Get orderbook entries, and sum total amount in orderbook
    let totAmountDUBLRWEI = ethers.constants.Zero;
    let maxPriceNWCPerDUBLR_x1e9 = ethers.constants.Zero;
    for (const order of orderbook) {
        totAmountDUBLRWEI = totAmountDUBLRWEI.add(order.amountDUBLRWEI);
        const price = !maxDisplayablePrice || order.priceNWCPerDUBLR_x1e9.lt(maxDisplayablePrice)
                ? order.priceNWCPerDUBLR_x1e9 : maxDisplayablePrice;
        if (price.gt(maxPriceNWCPerDUBLR_x1e9)) {
            maxPriceNWCPerDUBLR_x1e9 = price;
        }
    }
    
    // Produce vertices from orderbook entries
    let cumulAmountDUBLRWEI = ethers.constants.Zero;
    for (let i = 0; i < orderbook.length; i++) {
        let cumulY = 0;
        const order = orderbook[i];
        cumulAmountDUBLRWEI = cumulAmountDUBLRWEI.add(order.amountDUBLRWEI);
        const price = !maxDisplayablePrice || order.priceNWCPerDUBLR_x1e9.lt(maxDisplayablePrice)
                ? order.priceNWCPerDUBLR_x1e9 : maxDisplayablePrice;
        let priceX = toNumber(price);
        if (priceX) {
            priceX = Math.log(priceX * 1e-9);
            const cumulAmountFrac_x1e9 = toNumber(cumulAmountDUBLRWEI.mul(1e9).div(totAmountDUBLRWEI));
            if (cumulAmountFrac_x1e9 !== undefined) {
                cumulY = cumulAmountFrac_x1e9 * 1e-9;
                canvasVerts.push({
                    idx: i,
                    x: priceX,
                    y: cumulY,
                    order: order,
                });
            }
        }
    }
    // Add a false vertex at the beginning and end of the series, to provide some padding,
    // but also to handle the case of there being only one vertex (no orders, or one order
    // with the same price as the mint price)
    const minPriceX = canvasVerts.length === 0 ? 0 : canvasVerts[0].x;
    const maxPriceX = canvasVerts.length === 0 ? 0 : canvasVerts[canvasVerts.length - 1].x;
    let priceWidth = maxPriceX - minPriceX;
    if (priceWidth === 0) {
        priceWidth = 1;
    }
    const pricePadding = priceWidth / 20.0;
    canvasVerts.unshift({
        idx: -1,
        x: minPriceX - pricePadding,
        y: 0,
        order: undefined,
    });
    canvasVerts.push({
        idx: -1,
        x: maxPriceX + pricePadding,
        y: 1.0,
        order: undefined,
    });
    
    // Scale orderbook vertices to fit canvas
    const lw = 5;  // line width
    const aw = 24; // axis width
    const w = depthChartCanvas.width - 1 - lw - aw;
    const h = depthChartCanvas.height - 1 - lw - aw;
    const xs = lw/2 + aw;     // x start
    const ys = lw/2 + h;      // y start
    let minX;
    let maxX;
    let maxY;
    for (let i = 0; i < canvasVerts.length; i++) {
        const p = canvasVerts[i];
        if (minX === undefined || minX > p.x) {
            minX = p.x;
        }
        if (maxX === undefined || maxX < p.x) {
            maxX = p.x;
        }
        if (maxY === undefined || maxY < p.y) {
            maxY = p.y;
        }
    }
    const diffX = maxX - minX;
    const scaleX = w * (diffX < 1e-30 ? 1.0 : 1.0 / diffX);
    const scaleY = h * (maxY < 1e-30 ? 1.0 : 1.0 / maxY);
    for (let i = 0; i < canvasVerts.length; i++) {
        const p = canvasVerts[i];
        p.x = xs + (p.x - minX) * scaleX;
        p.y = ys - p.y * scaleY;
    }
    let mintX = toNumber(mintPriceNWCPerDUBLR_x1e9);
    if (mintX !== undefined) {
        mintX = Math.log(mintX * 1e-9);
        mintX = xs + (mintX - minX) * scaleX;
    }
    
    // Plot depth chart
    ctx.save();
    ctx.strokeStyle = "#ef9f9f";
    ctx.fillStyle = "#f7cfce";
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.moveTo(xs, ys);
    for (let i = 0; i < canvasVerts.length; i++) {
        const p = canvasVerts[i];
        // Draw vertical line
        ctx.lineTo(p.x, p.y);
        if (i < canvasVerts.length - 1) {
            // Draw horizontal line
            ctx.lineTo(canvasVerts[i + 1].x, p.y);
        }
    }
    ctx.lineTo(xs + w, ys);
    ctx.closePath();
    ctx.stroke();
    ctx.fill();
    ctx.restore();
    
    // Draw mint price line
    if (mintX !== undefined) {
        ctx.save();
        ctx.strokeStyle = "#e0403f";
        ctx.setLineDash([10, 5]);
        ctx.lineWidth = lw * .75;
        ctx.beginPath();
        ctx.moveTo(mintX, ys);
        ctx.lineTo(mintX, 0);
        ctx.stroke();
        ctx.restore();
        
        // Label mint price to left or right of mint price line, depending on which side of the midline
        // the mint price line is rendered
        ctx.save();
        ctx.fillStyle = "#e0403f";
        ctx.font = "13pt Maven Pro";
        const label = "Mint price";
        const labelWidth = ctx.measureText(label).width;
        ctx.fillText(label, (mintX - xs) / w < 0.5 ? mintX + 8 : mintX - labelWidth - 8, 20);
        ctx.restore();
    }
    
    // Label axes
    ctx.save();
    const xLabel = "log[Price (ETH per DUBLR)]";
    const yLabel = "Cumul amount (DUBLR)";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "13pt Maven Pro";
    ctx.beginPath();
    ctx.fillText(xLabel, xs + w/2, ys + 16);    
    ctx.translate(7, h/2 + 8);
    ctx.rotate(-Math.PI/2);
    ctx.fillText(yLabel, 0, 0);    
    ctx.restore();
    
    if (mouseOverVert) {
        // Highlight mouseover vertex
        ctx.save();
        ctx.beginPath();
        ctx.fillStyle = "#1e44a655";
        ctx.arc(mouseOverVert.x, mouseOverVert.y, 14, 0, 2 * Math.PI, false);
        ctx.fill();
        ctx.restore();

        // Copy orderbook entry HTML to display details of moused-over vertex
        const vertHtml = mouseOverVert.order.html || "";
        const ttHtml = vertHtml === "" ? ""
                : "<div style='text-align: center; margin-top: 24pt; margin-bottom: 12pt;'><b>"
                    + "Details for highlighted orderbook entry:</b></div>"
                    + vertHtml;
        dataflow.set({ mouseoverDetails_out: ttHtml });
    } else {
        dataflow.set({ mouseoverDetails_out: "" });
    }
}

// Highlight nearest vertex when mouse moves over canvas
function mouseMovedOverCanvas(e) {
    const rect = e.target.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    let closestVert = 0;
    let closestVertDistSq = Number.MAX_VALUE;
    for (let i = 0; i < canvasVerts.length; i++) {
        const vert = canvasVerts[i];
        if (vert.idx >= 0) {
            const dx = vert.x - mx;
            const dy = vert.y - my;
            const distSq = dx * dx + dy * dy;
            if (distSq < closestVertDistSq) {
                closestVert = vert;
                closestVertDistSq = distSq;
            }
        }
    }
    if (!mouseOverVert || (mouseOverVert && mouseOverVert.idx !== closestVert.idx)) {
        // Mouseover vert changed -- redraw
        mouseOverVert = closestVert;
        drawDepthChart();
    }
}

// Resize canvas to fit its parent every time tab2 is shown
// (size cannot be determined when other tabs are showing)
export function tab2Visible() {
    fitToContainer(depthChartCanvas);
}

// Clear highlighted vertex when mouse moves off canvas
function mouseMovedOffCanvas(e) {
    mouseOverVert = undefined;
    dataflow.set({ mouseoverDetails_out: "" });
    drawDepthChart();
}

// Resize canvas on window resize
window.onresize = () => fitToContainer(depthChartCanvas);

// Follow mouse movements over canvas
depthChartCanvas.onmousemove = mouseMovedOverCanvas;
depthChartCanvas.onmouseout = mouseMovedOffCanvas;

