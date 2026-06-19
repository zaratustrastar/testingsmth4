import { BrowserProvider, Contract, Interface, formatUnits, getAddress, parseUnits } from 'https://cdn.jsdelivr.net/npm/ethers@6.13.5/+esm'
import { CONFIG } from './config.js'
import { escapeHtml as e, sanitizeError, shortAddress, formatDate, money } from './format.js'
import { LIMITS, validateBorrowForm, isWriteDisabled } from './validation.js'
import { pAmountForBudget } from './quotes.js'
import { discoverCollateralTokens, searchTokens, sortTokensByWalletBalance } from './collateralDiscovery.js'
import { fallbackProvider, readContract, explorerLink } from './contracts.js'

const app = document.getElementById('app')
const $ = (id) => document.getElementById(id)
const STORAGE_KEY = 'pmfi-v22-borrow-draft'
const MAX_VAULT_READS = 4

let browserProvider
let signer
let account = ''
let chainId = 0
let activeTab = 'borrow'
let selectedLendId = ''
let notice = ''
let noticeDanger = false
let pending = false
let loadingPositions = true
let loadError = ''
let partialWarning = ''
let markets = []
let collateralTokens = []
let collateralLoading = true
let collateralError = ''
let selectorOpen = false
let selectorSearch = ''
let formTouched = false
let howOpen = false
let factoryState = { creationPaused: false, purchasesPaused: false, creationFee: CONFIG.CREATION_FEE_WEI, minFunding: BigInt(LIMITS.MIN_FUNDING_SECONDS), maxFunding: BigInt(LIMITS.MAX_FUNDING_SECONDS), maxRepayment: BigInt(LIMITS.MAX_REPAYMENT_SECONDS) }
let token = null
let borrowResult = null
let collateralPriceUsdc = null
let collateralPriceAddress = ''
let collateralPriceLoading = false

const factoryIface = new Interface(CONFIG.ABIS.factory)

function fmt(value, decimals = 18, max = 4) {
  try {
    const raw = typeof value === 'bigint' ? formatUnits(value, decimals) : String(value || '0')
    const n = Number(raw)
    return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: max }) : raw
  } catch { return '0' }
}
// Comma-free decimal string, safe to place back into number inputs (fixes slider/parse bug).
function plain(value, decimals, max = 8) {
  try {
    let s = formatUnits(value, decimals)
    if (s.includes('.')) { const [w, f] = s.split('.'); s = `${w}.${f.slice(0, max)}`.replace(/\.?0+$/, '') }
    return s || '0'
  } catch { return '0' }
}
function numFrom(v) { const n = Number(String(v ?? '').replace(/,/g, '').trim()); return Number.isFinite(n) ? n : 0 }
function parseAmount(value, decimals) { try { const v = String(value ?? '').replace(/,/g, '').trim(); return v && Number(v) > 0 ? parseUnits(v, decimals) : 0n } catch { return 0n } }
function nowSec() { return Math.floor(Date.now() / 1000) }
function secondsFromDays(days) { return Math.max(1, Number(days)) * 86400 }
function apr(investment, payoff, start, end) { return investment > 0 && payoff > investment && end > start ? ((payoff - investment) / investment) * (31536000 / (end - start)) * 100 : 0 }
function isBase() { return chainId === CONFIG.BASE_CHAIN_ID }
function providerForReads() { return browserProvider || fallbackProvider() }
function factory(readonly = true) { return new Contract(CONFIG.FACTORY_ADDRESS, CONFIG.ABIS.factory, readonly || !signer ? providerForReads() : signer) }
function marketplace(readonly = true) { return new Contract(CONFIG.MARKETPLACE_ADDRESS, CONFIG.ABIS.marketplace, readonly || !signer ? providerForReads() : signer) }
function vaultContract(address, readonly = true) { return new Contract(address, CONFIG.ABIS.vault, readonly || !signer ? providerForReads() : signer) }
function erc20(address, readonly = true) { return new Contract(address, CONFIG.ABIS.erc20, readonly || !signer ? providerForReads() : signer) }
function txLink(hash) { return `<a target="_blank" rel="noopener noreferrer" href="${explorerLink(hash, 'tx')}">${shortAddress(hash)}</a>` }
function addressLink(address) { return `<a target="_blank" rel="noopener noreferrer" href="${explorerLink(address)}">${shortAddress(address)}</a>` }
function setNotice(message, danger = false) { notice = message; noticeDanger = danger; const el = $('notice'); if (el) { el.hidden = false; el.className = `notice ${danger ? 'danger' : ''}`; el.innerHTML = message } }
function setNoticeText(message, danger = false) { setNotice(e(message), danger) }
function clearNotice() { notice = ''; const el = $('notice'); if (el) el.hidden = true }
/* ---------- Token logo cache ----------
   Priority: local override → Uniswap token list → letter fallback.
   Fetched in background after collateral discovery; never blocks enable state.
   logoCache: address(lowercase) → img URL string | null (null = no logo found)
*/
const LOGO_OVERRIDES = {
  // address lowercase → direct image URL
  '0x5f980dcfc4c0fa3911554cf5ab288ed0eb13dba3': 'https://assets.coingecko.com/coins/images/36652/small/gitlaw.png',
  '0xd77ce6d3137342bb5174673bdab5f51db16fcba3': 'https://assets.coingecko.com/coins/images/36651/small/pmfi.png',
  '0x22af33fe49fd1fa80c7149773dde5890d3c76f3b': 'https://assets.coingecko.com/coins/images/36650/small/bnkr.png',
  '0x4200000000000000000000000000000000000006': 'https://assets.coingecko.com/coins/images/279/small/ethereum.png',
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 'https://assets.coingecko.com/coins/images/6319/small/usdc.png',
}
const logoCache = new Map()
let uniswapList = null

async function getUniswapList() {
  if (uniswapList) return uniswapList
  try {
    const r = await fetch('https://tokens.uniswap.org')
    if (!r.ok) throw new Error('not ok')
    const data = await r.json()
    uniswapList = {}
    for (const t of (data.tokens || [])) {
      if (t.chainId === 8453 && t.logoURI) uniswapList[t.address.toLowerCase()] = t.logoURI
    }
  } catch { uniswapList = {} }
  return uniswapList
}

async function resolveTokenLogo(address) {
  const key = address.toLowerCase()
  if (logoCache.has(key)) return logoCache.get(key)
  // 1. Local override
  if (LOGO_OVERRIDES[key]) { logoCache.set(key, LOGO_OVERRIDES[key]); return LOGO_OVERRIDES[key] }
  // 2. Uniswap list (Base chainId 8453)
  const list = await getUniswapList()
  if (list[key]) { logoCache.set(key, list[key]); return list[key] }
  logoCache.set(key, null)
  return null
}

async function prefetchLogos(tokens) {
  // Fire-and-forget; re-render modal if open after loading
  await getUniswapList()
  let needsRender = false
  for (const t of tokens) {
    const key = t.address.toLowerCase()
    if (!logoCache.has(key)) {
      await resolveTokenLogo(t.address)
      needsRender = true
    }
  }
  if (needsRender && selectorOpen) renderBorrow()
}

function tokenLogoImg(address, symbol, size = 38) {
  const key = address?.toLowerCase()
  const url = key ? logoCache.get(key) : undefined
  if (url) return `<img src="${e(url)}" alt="${e(symbol)}" width="${size}" height="${size}" class="token-logo" onerror="this.style.display='none';this.nextElementSibling.style.display='grid'">`
  return ''
}

function tokenIcon(symbol, address) {
  const key = address?.toLowerCase()
  const url = key ? logoCache.get(key) : undefined
  const letter = `<span class="token-icon" ${url ? 'style="display:none"' : ''}>${e(String(symbol || 'T').slice(0, 1).toUpperCase())}</span>`
  if (url) return `<span class="token-icon-wrap">${tokenLogoImg(address, symbol)}<span class="token-icon" style="display:none">${e(String(symbol || 'T').slice(0, 1).toUpperCase())}</span></span>`
  return letter
}
function infoTip() { return '<span class="info">i</span>' }
function moneyApprox(value) {
  return Number.isFinite(value) && value > 0 ? `≈ $${money(value)}` : '≈ —'
}
async function loadCollateralPrice(selectedToken) {
  if (!selectedToken?.address) {
    collateralPriceUsdc = null
    collateralPriceAddress = ''
    collateralPriceLoading = false
    return
  }
  const address = selectedToken.address.toLowerCase()
  collateralPriceAddress = address
  collateralPriceLoading = true
  try {
    if (address === CONFIG.BASE_USDC.toLowerCase()) {
      collateralPriceUsdc = 1
      return
    }
    const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${selectedToken.address}`)
    if (!response.ok) throw new Error('price unavailable')
    const data = await response.json()
    const pairs = (data.pairs || []).filter((pair) => pair.chainId === 'base' && Number(pair.priceUsd) > 0)
    pairs.sort((a, b) => Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0))
    collateralPriceUsdc = pairs.length ? Number(pairs[0].priceUsd) : null
  } catch {
    collateralPriceUsdc = null
  } finally {
    collateralPriceLoading = false
    if (token?.address?.toLowerCase() === address) renderBorrow()
  }
}
function saveDraft() {
  const ids = ['selectedCollateral', 'lockAmount', 'raiseUsdc', 'repayUsdc', 'fundingHours', 'repaymentDays']
  const draft = Object.fromEntries(ids.map((id) => [id, $(id)?.value || '']))
  draft.selectedCollateral = token?.address || draft.selectedCollateral || ''
  draft.selectedDecimals = token?.decimals ?? draft.selectedDecimals ?? ''
  localStorage.setItem(STORAGE_KEY, JSON.stringify(draft))
}
function readDraft() { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') } catch { return {} } }
function saleTuple(s) { return { vault: s.vault ?? s[0], seller: s.seller ?? s[1], pToken: s.pToken ?? s[2], amountInitial: s.amountInitial ?? s[3], amountRemaining: s.amountRemaining ?? s[4], usdcTotal: s.usdcTotal ?? s[5], usdcRemaining: s.usdcRemaining ?? s[6], usdcRaisedToSeller: s.usdcRaisedToSeller ?? s[7], feeAccrued: s.feeAccrued ?? s[8], expiry: s.expiry ?? s[9], active: s.active ?? s[10] } }
function parsePositionCreated(receipt) {
  for (const log of receipt.logs || []) {
    if (String(log.address).toLowerCase() !== CONFIG.FACTORY_ADDRESS.toLowerCase()) continue
    try {
      const parsed = factoryIface.parseLog(log)
      if (parsed?.name === 'PositionCreated') return parsed.args
    } catch {}
  }
  throw new Error('PositionCreated event not found in receipt')
}
async function sendTx(label, action) {
  if (pending) return
  pending = true
  try {
    setNotice(`<strong>${e(label)}</strong> preparing…`)
    const tx = await action((phase) => setNotice(`<strong>${e(label)}</strong> ${e(phase)}`))
    setNotice(`<strong>${e(label)}</strong> submitted ${txLink(tx.hash)}. Awaiting confirmation…`)
    const receipt = await tx.wait()
    setNotice(`<strong>${e(label)}</strong> confirmed ${txLink(tx.hash)}.`)
    await refreshAll()
    return { tx, receipt }
  } catch (error) {
    setNotice(`<strong>${e(label)}</strong> failed: ${sanitizeError(error)}`, true)
    throw error
  } finally {
    pending = false
    render()
  }
}

async function connect() {
  if (!window.ethereum) return setNoticeText('No wallet detected. Install a browser wallet to send transactions.', true)
  browserProvider = new BrowserProvider(window.ethereum)
  await browserProvider.send('eth_requestAccounts', [])
  signer = await browserProvider.getSigner()
  account = await signer.getAddress()
  chainId = Number((await browserProvider.getNetwork()).chainId)
  await refreshAll()
  await render()
}
async function switchToBase() {
  if (!window.ethereum) return
  try { await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CONFIG.BASE_CHAIN_HEX }] }) }
  catch (error) {
    if (error.code === 4902) {
      await window.ethereum.request({ method: 'wallet_addEthereumChain', params: [{ chainId: CONFIG.BASE_CHAIN_HEX, chainName: 'Base Mainnet', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: [CONFIG.BASE_RPC], blockExplorerUrls: [CONFIG.EXPLORER_URL] }] })
    } else throw error
  }
}
function setupWalletEvents() {
  if (!window.ethereum) return
  window.ethereum.on?.('accountsChanged', async (accounts) => { account = accounts?.[0] ? getAddress(accounts[0]) : ''; signer = account && browserProvider ? await browserProvider.getSigner() : undefined; token = null; await refreshAll(); await render() })
  window.ethereum.on?.('chainChanged', async () => { browserProvider = new BrowserProvider(window.ethereum); signer = account ? await browserProvider.getSigner() : undefined; chainId = Number((await browserProvider.getNetwork()).chainId); token = null; await refreshAll(); await render() })
}

async function discoverCollateral() {
  collateralLoading = true
  collateralError = ''
  try {
    const provider = providerForReads()
    const f = factory(true)
    const latest = await provider.getBlockNumber()
    const topic = factoryIface.getEvent('CollateralAllowed').topicHash
    collateralTokens = await discoverCollateralTokens({
      fromBlock: CONFIG.FACTORY_DEPLOYMENT_BLOCK,
      toBlock: latest,
      getLogs: (fromBlock, toBlock) => provider.getLogs({ address: CONFIG.FACTORY_ADDRESS, topics: [topic], fromBlock: Number(fromBlock), toBlock: Number(toBlock) }),
      parseLog: (log) => factoryIface.parseLog(log).args,
      isAllowed: (address) => f.collateralAllowed(address),
      readMetadata: async (address) => {
        const c = readContract(address, CONFIG.ABIS.erc20, provider)
        const [symbol, name, decimals, balance] = await Promise.all([
          c.symbol().catch(() => 'TOKEN'), c.name().catch(() => ''), c.decimals().catch(() => 18n), account ? c.balanceOf(account).catch(() => 0n) : 0n,
        ])
        return { symbol, name, decimals, balance }
      },
    })
    if (token && !collateralTokens.some((item) => item.address.toLowerCase() === token.address.toLowerCase())) token = null
    prefetchLogos(collateralTokens)
  } catch (error) {
    collateralError = sanitizeError(error)
    collateralTokens = []
  } finally { collateralLoading = false }
}
async function refreshFactoryState() {
  const f = factory(true)
  const [creationPaused, purchasesPaused, creationFee, minFunding, maxFunding, maxRepayment] = await Promise.all([
    f.creationPaused(), f.purchasesPaused(), f.CREATION_FEE(), f.MIN_FUNDING_PERIOD(), f.MAX_FUNDING_PERIOD(), f.MAX_REPAYMENT_PERIOD(),
  ])
  factoryState = { creationPaused, purchasesPaused, creationFee, minFunding, maxFunding, maxRepayment }
}
async function mapLimit(items, limit, fn) {
  const out = []
  let i = 0
  async function worker() { while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx) } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}
async function loadVault(vaultAddress) {
  const f = factory(true)
  if (!(await f.isVault(vaultAddress))) throw new Error('Unregistered vault')
  const v = vaultContract(vaultAddress, true)
  const [borrower, collateral, usdc, pToken, nToken, cDec, uDec, initialCollateralAmount, targetRaiseUsdc, totalRepaymentUsdc, fundingDeadline, repaymentDeadline, initialized, fundingClosed, settled, closedWithoutOutstandingP, pairedN, exercisedN, usdcPaid, accountedCollateral, collateralRefundClaim, repaymentRequiredUsdc, repaymentRemainingUsdc, canSettleEarly] = await Promise.all([
    v.borrower(), v.collateral(), v.usdc(), v.P(), v.N(), v.collateralDecimals(), v.usdcDecimals(), v.initialCollateralAmount(), v.targetRaiseUsdc(), v.totalRepaymentUsdc(), v.fundingDeadline(), v.repaymentDeadline(), v.initialized(), v.fundingClosed(), v.settled(), v.closedWithoutOutstandingP(), v.pairedN(), v.exercisedN(), v.usdcPaid(), v.accountedCollateral(), v.collateralRefundClaim(), v.repaymentRequiredUsdc(), v.repaymentRemainingUsdc(), v.canSettleEarly().catch(() => false),
  ])
  const c = erc20(collateral, true), p = erc20(pToken, true), n = erc20(nToken, true)
  const [symbol, name, pSupply, pBalance, nBalance] = await Promise.all([
    c.symbol().catch(() => 'TOKEN'), c.name().catch(() => 'Custom token'), p.totalSupply().catch(() => 0n), account ? p.balanceOf(account).catch(() => 0n) : 0n, account ? n.balanceOf(account).catch(() => 0n) : 0n,
  ])
  const saleIdPlusOne = await marketplace(true).saleIdPlusOneByVault(vaultAddress).catch(() => 0n)
  const saleId = saleIdPlusOne > 0n ? saleIdPlusOne - 1n : null
  const sale = saleId !== null ? saleTuple(await marketplace(true).sales(saleId)) : null
  let preview = { collateralOut: 0n, usdcOut: 0n }
  if (settled && pBalance > 0n) { try { const r = await v.previewRedeemP(pBalance); preview = { collateralOut: r[0], usdcOut: r[1] } } catch {} }
  const funded = initialCollateralAmount > 0n ? initialCollateralAmount - (sale?.amountRemaining || 0n) : 0n
  return { id: vaultAddress, vault: vaultAddress, borrower, collateral, usdc, pToken, nToken, token: symbol, name, decimals: Number(cDec), usdcDecimals: Number(uDec), initialCollateralAmount, targetRaiseUsdc, totalRepaymentUsdc, fundingDeadline, repaymentDeadline, initialized, fundingClosed, settled, closedWithoutOutstandingP, pairedN, exercisedN, usdcPaid, accountedCollateral, collateralRefundClaim, repaymentRequiredUsdc, repaymentRemainingUsdc, canSettleEarly, pSupply, pBalance, nBalance, saleId, sale, preview, funded }
}
async function loadPositions() {
  loadingPositions = true; loadError = ''; partialWarning = ''
  try {
    const f = factory(true)
    const len = Number(await f.allVaultsLength())
    const vaults = await Promise.all(Array.from({ length: len }, (_, i) => f.allVaults(i)))
    const settled = await mapLimit(vaults, MAX_VAULT_READS, async (vaultAddress) => loadVault(vaultAddress).catch((error) => ({ error, vaultAddress })))
    const failures = settled.filter((x) => x?.error)
    markets = settled.filter((x) => !x?.error)
    if (failures.length) partialWarning = `${failures.length} position${failures.length === 1 ? '' : 's'} could not be loaded from the public RPC.`
  } catch (error) {
    loadError = sanitizeError(error)
    markets = []
  } finally { loadingPositions = false }
}
async function refreshAll() {
  try { await refreshFactoryState() } catch (error) { loadError = sanitizeError(error) }
  await discoverCollateral()
  await loadPositions()
}

function liveOpenMarkets() {
  const t = BigInt(nowSec())
  return markets.filter((m) => m.sale && m.sale.active && m.sale.amountRemaining > 0n && m.fundingDeadline > t && !m.fundingClosed && !m.settled)
}
function selectedMarket() { return liveOpenMarkets().find((m) => m.id === selectedLendId) || liveOpenMarkets()[0] }
function fillPct(m) { return m.initialCollateralAmount ? Number((m.funded * 10000n) / m.initialCollateralAmount) / 100 : 0 }
function estimatedApr(m) { return apr(Number(formatUnits(m.targetRaiseUsdc, 6)), Number(formatUnits(m.totalRepaymentUsdc, 6)), Number(m.fundingDeadline), Number(m.repaymentDeadline)) }

function aggStats() {
  const live = liveOpenMarkets()
  const sum = (arr, pick) => arr.reduce((s, m) => s + (pick(m) || 0n), 0n)
  return {
    liveCount: live.length,
    totalPositions: markets.length,
    settledCount: markets.filter((m) => m.settled).length,
    available: sum(live, (m) => m.sale?.usdcRemaining),
    liveRaise: sum(live, (m) => m.targetRaiseUsdc),
    bestApr: live.reduce((b, m) => Math.max(b, estimatedApr(m)), 0),
  }
}

/* ---------- Shell + hero ---------- */
function heroBlock(title, sub, stats) {
  return `<section class="hero"><div class="hero-copy"><h1>${title}</h1><p>${e(sub)}</p></div><div class="hero-stats">${stats.map(([k, v]) => `<div class="stat"><strong>${e(v)}</strong><span>${e(k)}</span></div>`).join('')}</div></section>`
}
function heroFor() {
  const s = aggStats()
  if (activeTab === 'borrow') return heroBlock(`Borrow USDC <span class="accent">against your tokens</span>`, 'Lock collateral, raise USDC, repay a fixed amount by your deadline. No oracle, no liquidation, limited risk.', [['Live positions', String(s.liveCount)], ['Enabled collateral', String(collateralTokens.length)], ['Created to date', String(s.totalPositions)]])
  if (activeTab === 'lend') return heroBlock(`Earn <span class="accent">fixed yield</span> on USDC`, 'Fund a position and lock in a fixed repayment. If the borrower repays, you keep the yield. If they do not, you claim the collateral.', [['Best est. APR', s.bestApr > 0 ? `${s.bestApr.toFixed(1)}%` : '—'], ['Open to fund', String(s.liveCount)], ['Available now', `${fmt(s.available, 6, 0)} USDC`]])
  return heroBlock(`Your <span class="accent">positions</span>`, 'Track everything you have borrowed and lent, and act on it, in one place.', [['Repaid', String(s.settledCount)], ['Positions', String(s.totalPositions)], ['Network', 'Base']])
}
function renderNotice() {
  const wrong = account && !isBase()
  const warning = wrong ? `<div class="notice danger"><strong>Wrong network.</strong> Switch to Base Mainnet to send transactions. <button id="switchBase" class="link-btn">Switch to Base</button></div>` : ''
  return `${warning}<div id="notice" class="notice ${noticeDanger ? 'danger' : ''}" ${notice ? '' : 'hidden'}>${notice}</div>${loadError ? `<div class="notice danger"><strong>Network read failed.</strong> ${loadError} <button id="retryLoad" class="link-btn">Retry</button></div>` : ''}${partialWarning ? `<div class="notice"><strong>Partial data.</strong> ${e(partialWarning)} <button id="retryLoad2" class="link-btn">Retry</button></div>` : ''}`
}
async function render() {
  try {
    app.innerHTML = `<div class="bg-grid" aria-hidden="true"></div><div class="shell"><header class="nav"><div class="brand"><span class="logo" aria-hidden="true"><svg width="30" height="30" viewBox="0 0 1024 1024" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="512" cy="512" r="504" fill="#ECEEF4"/><path d="M110 825L925 250" stroke="#0A1020" stroke-width="18" stroke-linecap="round"/><circle cx="512" cy="512" r="154" fill="#0A1020"/></svg></span> PMFI</div><nav class="tabs" aria-label="Main tabs"><button data-tab="borrow" class="${activeTab === 'borrow' ? 'active' : ''}">Borrow</button><button data-tab="lend" class="${activeTab === 'lend' ? 'active' : ''}">Lend</button><button data-tab="portfolio" class="${activeTab === 'portfolio' ? 'active' : ''}">Portfolio</button></nav><button id="connect" class="connect ${account ? 'connected' : ''}">${account ? `<span class="dot"></span>${e(shortAddress(account))}` : 'Connect wallet'}</button></header>${heroFor()}${renderNotice()}<main id="view"></main><footer class="foot"><span>No oracle · No liquidation · Fixed repayment</span><span class="foot-links">Factory ${addressLink(CONFIG.FACTORY_ADDRESS)} · Marketplace ${addressLink(CONFIG.MARKETPLACE_ADDRESS)}</span></footer></div>`
    $('connect').onclick = connect
    $('switchBase')?.addEventListener('click', switchToBase)
    $('retryLoad')?.addEventListener('click', async () => { await refreshAll(); render() })
    $('retryLoad2')?.addEventListener('click', async () => { await refreshAll(); render() })
    document.querySelectorAll('[data-tab]').forEach((button) => button.onclick = () => { activeTab = button.dataset.tab; render() })
    if (activeTab === 'borrow') renderBorrow()
    if (activeTab === 'lend') renderLend()
    if (activeTab === 'portfolio') renderPortfolio()
  } catch (error) {
    app.innerHTML = `<div class="shell"><div class="notice danger"><strong>Something broke in the interface.</strong> ${sanitizeError(error)}</div><button class="connect" onclick="location.reload()">Reload</button></div>`
  }
}

/* ---------- Borrow ---------- */
function selectedTokenCard() {
  if (!token) return '<button id="openTokenSelector" class="select-token-card placeholder"><span>Choose a token</span><small>Only collateral enabled by the onchain allowlist</small></button>'
  return `<button id="openTokenSelector" class="select-token-card"><span>${tokenIcon(token.symbol, token.address)}<strong>${e(token.symbol)}</strong></span><small>${e(token.name)} · ${shortAddress(token.address)}</small><em>Balance ${e(fmt(token.balance, token.decimals, 6))}</em></button>`
}
function tokenRows(tokens, emptyText) {
  return tokens.length ? tokens.map((item) => `<button class="token-row" data-select-collateral="${e(item.address)}">${tokenIcon(item.symbol, item.address)}<span><strong>${e(item.symbol)}</strong><small>${e(item.name)} · ${shortAddress(item.address)}</small></span><em>${e(fmt(item.balance, item.decimals, 6))}</em></button>`).join('') : `<p class="empty-state compact">${e(emptyText)}</p>`
}
function tokenSelectorModal() {
  if (!selectorOpen) return ''
  const searched = sortTokensByWalletBalance(searchTokens(collateralTokens, selectorSearch))
  const owned = searched.filter((item) => item.balance > 0n)
  return `<div class="modal-backdrop" id="selectorBackdrop"><div class="token-modal" role="dialog" aria-modal="true" aria-labelledby="tokenModalTitle"><div class="modal-head"><h2 id="tokenModalTitle">Select collateral</h2><button id="closeTokenSelector" class="modal-close" aria-label="Close">×</button></div><div class="search-input token-search"><span>⌕</span><input id="tokenSearch" placeholder="Search by name, ticker, or address" value="${e(selectorSearch)}" autofocus></div>${collateralLoading ? '<div class="empty-state compact">Reading enabled collateral from the factory…</div>' : collateralError ? `<div class="notice danger"><strong>Could not load collateral.</strong> ${collateralError} <button id="retryCollateral" class="link-btn">Retry</button></div>` : `<section class="selector-section"><h3>In your wallet</h3>${tokenRows(owned, 'No enabled collateral in your wallet yet.')}</section><section class="selector-section"><h3>All enabled collateral</h3>${tokenRows(searched, 'No enabled collateral matches that search.')}</section>`}</div></div>`
}
function generatedNamePrefix() { return `opl ${String(token?.symbol || 'TOKEN')}`.slice(0, 32) }
function generatedSymbolPrefix() { return `opl${String(token?.symbol || 'TOKEN')}`.slice(0, 32) }
function borrowEconomics() {
  const raise = numFrom($('raiseUsdc')?.value), repay = numFrom($('repayUsdc')?.value)
  const fundingHours = Number($('fundingHours')?.value || 24), repaymentDays = Number($('repaymentDays')?.value || 180)
  const fundingDeadline = nowSec() + fundingHours * 3600
  const repaymentDeadline = fundingDeadline + secondsFromDays(repaymentDays)
  const cost = repay > raise ? repay - raise : 0
  return { cost, aprPct: apr(raise, repay, fundingDeadline, repaymentDeadline), fundingDeadline, repaymentDeadline }
}
function borrowSuggestions() {
  const collateralAmount = numFrom($('lockAmount')?.value)
  const repaymentDays = Number($('repaymentDays')?.value || 180)
  const estimatedCollateralValueUsdc = collateralAmount * Number(collateralPriceUsdc || 0)
  const suggestedRaiseUsdc = estimatedCollateralValueUsdc * 0.90
  const repaymentMonths = repaymentDays / 30
  const suggestedRepaymentUsdc = suggestedRaiseUsdc * (1 + 0.05 * repaymentMonths)
  return { estimatedCollateralValueUsdc, suggestedRaiseUsdc, suggestedRepaymentUsdc }
}
function borrowBlockReason() {
  if (!account) return 'Connect your wallet to continue'
  if (!isBase()) return 'Switch to Base to create a position'
  if (factoryState.creationPaused) return 'Position creation is paused onchain'
  if (!token) return 'Select a collateral token'
  if (!token.allowed) return 'This token is not enabled by the factory allowlist'
  if (!(numFrom($('lockAmount')?.value) > 0)) return 'Enter how much collateral to lock'
  if (token.balance != null && parseAmount($('lockAmount')?.value, token.decimals) > token.balance) return 'Amount is more than your wallet balance'
  if (!(numFrom($('raiseUsdc')?.value) > 0)) return 'Enter how much USDC you want to raise'
  if (!(numFrom($('repayUsdc')?.value) > 0)) return 'Enter the total repayment amount'
  if (!(numFrom($('repayUsdc')?.value) > numFrom($('raiseUsdc')?.value))) return 'Total repayment must be greater than the raise'
  return ''
}
function isBorrowFormReady() { return borrowBlockReason() === '' }
function renderBorrow() {
  const draft = readDraft()
  if (!token && draft.selectedCollateral) token = collateralTokens.find((item) => item.address.toLowerCase() === String(draft.selectedCollateral).toLowerCase()) || null
  $('view').innerHTML = `<section class="borrow-layout"><div class="card form-card"><div class="card-head"><h2>Create a borrow position</h2></div>
    <label>Collateral</label><div id="selectedTokenBox">${selectedTokenCard()}</div>
    <label>Amount to lock <strong id="amountLabel" class="term-label">0%</strong></label>
    <div class="amount-row"><input id="lockAmount" inputmode="decimal" placeholder="0.0" value="${e(draft.lockAmount || '')}"></div>
    <p id="estimatedCollateralHelper" class="field-helper">Estimated collateral value <strong>≈ —</strong></p>
    <input id="amountPercent" type="range" min="0" max="100" value="0" aria-label="Percent of balance to lock">
    <div class="chips"><button data-pct="25">25%</button><button data-pct="50">50%</button><button data-pct="75">75%</button><button data-pct="100">Max</button></div>
    <div class="two-cols"><div><label>USDC to raise ${infoTip()}</label><div class="unit-input"><input id="raiseUsdc" inputmode="decimal" placeholder="0" value="${e(draft.raiseUsdc || '')}"><span>USDC</span></div><p id="suggestedRaiseHelper" class="field-helper">Suggested USDC to raise <strong>≈ —</strong></p></div><div><label>Total repayment ${infoTip()}</label><div class="unit-input"><input id="repayUsdc" inputmode="decimal" placeholder="0" value="${e(draft.repayUsdc || '')}"><span>USDC</span></div><p id="suggestedRepaymentHelper" class="field-helper">Suggested total repayment <strong>≈ —</strong></p></div></div>
    <div class="field-gap"></div>
    <div class="two-cols"><div><label>Funding window <strong id="fundingLabel" class="term-label">24 hours</strong></label><input id="fundingHours" type="range" min="1" max="720" value="${e(draft.fundingHours || '24')}"></div><div><label>Repayment window <strong id="repaymentLabel" class="term-label">180 days</strong></label><input id="repaymentDays" type="range" min="1" max="365" value="${e(draft.repaymentDays || '180')}"></div></div>
    <div id="borrowProgress" class="tx-steps" hidden></div>
    <button id="createBorrow" class="primary-action" disabled>Create borrow position</button>
    <p id="createHint" class="action-hint"></p>
    <p class="fee-note">Creation fee ${CONFIG.CREATION_FEE_ETH} ETH</p></div>
    <aside><div class="card preview-card"><h2>Position preview</h2><div id="borrowPreview"></div>
    <div id="borrowResult"></div></div>
    <div class="card split-card"><button id="toggleHow" class="how-toggle">How it works <span>${howOpen ? '−' : '+'}</span></button><div class="how-body" ${howOpen ? '' : 'hidden'}>${splitModule('borrow')}</div></div></aside>${tokenSelectorModal()}</section>`
  const update = () => {
    const fundingHours = Number($('fundingHours').value || 24), repaymentDays = Number($('repaymentDays').value || 180)
    $('fundingLabel').textContent = `${fundingHours} ${fundingHours === 1 ? 'hour' : 'hours'}`
    $('repaymentLabel').textContent = `${repaymentDays} ${repaymentDays === 1 ? 'day' : 'days'}`
    const pct = token && token.balance > 0n ? Math.max(0, Math.min(100, Math.round((numFrom($('lockAmount').value) / Number(formatUnits(token.balance, token.decimals))) * 100))) : 0
    $('amountLabel').textContent = `${Number.isFinite(pct) ? pct : 0}%`
    if (document.activeElement?.id !== 'amountPercent') $('amountPercent').value = String(Number.isFinite(pct) ? pct : 0)
    const suggestions = borrowSuggestions()
    const pricePending = collateralPriceLoading && token?.address?.toLowerCase() === collateralPriceAddress
    $('estimatedCollateralHelper').innerHTML = `Estimated collateral value <strong>${pricePending ? 'loading…' : e(moneyApprox(suggestions.estimatedCollateralValueUsdc))}</strong>`
    $('suggestedRaiseHelper').innerHTML = `Suggested USDC to raise <strong>${pricePending ? 'loading…' : e(moneyApprox(suggestions.suggestedRaiseUsdc))}</strong>`
    $('suggestedRepaymentHelper').innerHTML = `Suggested total repayment <strong>${pricePending ? 'loading…' : e(moneyApprox(suggestions.suggestedRepaymentUsdc))}</strong>`
    const symbol = token?.symbol || 'TOKEN'
    const ec = borrowEconomics()
    $('borrowPreview').innerHTML = previewRows([
      ['Collateral locked', `${e($('lockAmount').value || '0')} ${e(symbol)}`],
      ['USDC you raise', `${e(money(numFrom($('raiseUsdc').value)))} USDC`],
      ['Fixed repayment', `${e(money(numFrom($('repayUsdc').value)))} USDC`],
      ['Borrow cost', ec.cost > 0 ? `<span class="warn-text">${e(money(ec.cost))} USDC</span>` : '—'],
      ['Implied APR', ec.aprPct > 0 ? `<span class="green">${ec.aprPct.toFixed(1)}%</span>` : '—'],
      ['Funding deadline', formatDate(ec.fundingDeadline)],
      ['Repayment deadline', formatDate(ec.repaymentDeadline)],
    ])
    saveDraft()
    const reason = borrowBlockReason()
    $('createBorrow').disabled = reason !== ''
    $('createHint').textContent = reason
  }
  const setPct = (p) => { if (!token) return; $('lockAmount').value = plain((token.balance * BigInt(p)) / 100n, token.decimals); $('amountPercent').value = String(p); formTouched = true; update() }
  $('openTokenSelector')?.addEventListener('click', () => { selectorOpen = true; renderBorrow() })
  $('closeTokenSelector')?.addEventListener('click', () => { selectorOpen = false; renderBorrow() })
  $('selectorBackdrop')?.addEventListener('click', (event) => { if (event.target.id === 'selectorBackdrop') { selectorOpen = false; renderBorrow() } })
  $('retryCollateral')?.addEventListener('click', async () => { await discoverCollateral(); renderBorrow() })
  $('tokenSearch')?.addEventListener('input', (event) => { selectorSearch = event.target.value; renderBorrow() })
  document.querySelectorAll('[data-select-collateral]').forEach((button) => button.onclick = () => {
    const selected = collateralTokens.find((item) => item.address.toLowerCase() === button.dataset.selectCollateral.toLowerCase())
    if (!selected) return
    token = selected
    selectorOpen = false
    selectorSearch = ''
    $('lockAmount').value = ''
    $('amountPercent').value = '0'
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...readDraft(), selectedCollateral: token.address, selectedDecimals: token.decimals, lockAmount: '' }))
    renderBorrow()
  })
  document.querySelectorAll('[data-pct]').forEach((button) => button.onclick = () => setPct(Number(button.dataset.pct)))
  $('amountPercent').oninput = () => { if (token) $('lockAmount').value = plain((token.balance * BigInt($('amountPercent').value || 0)) / 100n, token.decimals); formTouched = true; update() }
  ;['lockAmount', 'raiseUsdc', 'repayUsdc', 'fundingHours', 'repaymentDays'].forEach((id) => $(id).oninput = () => { formTouched = true; update() })
  $('toggleHow')?.addEventListener('click', () => { howOpen = !howOpen; renderBorrow() })
  $('createBorrow').onclick = async () => { formTouched = true; await createBorrowPosition(update) }
  if (borrowResult) $('borrowResult').innerHTML = borrowResult
  if (token?.address && token.address.toLowerCase() !== collateralPriceAddress && !collateralPriceLoading) loadCollateralPrice(token)
  update()
}
async function createBorrowPosition(update) {
  if (!token) return setNoticeText('Select an enabled collateral token first.', true)
  const liveAllowed = await factory(true).collateralAllowed(token.address).catch(() => false)
  if (!liveAllowed) return setNoticeText('That collateral is no longer enabled by the onchain factory allowlist.', true)
  token.allowed = true
  const collateralAmount = parseAmount($('lockAmount').value, token.decimals)
  const targetRaise = parseAmount($('raiseUsdc').value, 6)
  const totalRepayment = parseAmount($('repayUsdc').value, 6)
  const fundingSeconds = Number($('fundingHours').value || 24) * 3600
  const repaymentSeconds = secondsFromDays($('repaymentDays').value || 180)
  const ethBalance = account && browserProvider ? await browserProvider.getBalance(account).catch(() => 0n) : 0n
  const errors = validateBorrowForm({ connected: Boolean(account), wrongNetwork: account && !isBase(), creationPaused: factoryState.creationPaused, collateralAllowed: token.allowed, collateralIsUsdc: token.isUsdc, collateralAmount, targetRaise, totalRepayment, fundingSeconds, repaymentSeconds, namePrefix: generatedNamePrefix(), symbolPrefix: generatedSymbolPrefix(), decimals: token.decimals, balance: token.balance, ethBalance })
  if (errors.length) return setNoticeText(errors.join('; '), true)
  const progress = $('borrowProgress'); progress.hidden = false; progress.innerHTML = '<span>1 · Approve collateral — pending</span><span>2 · Create position — waiting</span>'
  const collateral = erc20(token.address, false)
  const allowance = await collateral.allowance(account, CONFIG.FACTORY_ADDRESS)
  if (allowance < collateralAmount) {
    await sendTx('Approve collateral', async (phase) => { phase('confirm in your wallet…'); return collateral.approve(CONFIG.FACTORY_ADDRESS, collateralAmount) })
    const reread = await erc20(token.address, true).allowance(account, CONFIG.FACTORY_ADDRESS)
    if (reread < collateralAmount) return setNoticeText('Approval was not sufficient after confirmation.', true)
  }
  progress.innerHTML = '<span>1 · Approve collateral — done</span><span>2 · Create position — pending</span>'
  const fundingDeadline = BigInt(nowSec() + fundingSeconds)
  const repaymentDeadline = fundingDeadline + BigInt(repaymentSeconds)
  const params = { collateral: token.address, collateralAmount, targetRaiseUsdc: targetRaise, totalRepaymentUsdc: totalRepayment, fundingDeadline, repaymentDeadline, namePrefix: generatedNamePrefix(), symbolPrefix: generatedSymbolPrefix() }
  const result = await sendTx('Create position', async (phase) => { phase('confirm in your wallet…'); return factory(false).createPosition(params, { value: CONFIG.CREATION_FEE_WEI }) })
  const event = parsePositionCreated(result.receipt)
  borrowResult = `<div class="result-links"><strong>Position created</strong><span>Vault ${addressLink(event.vault)}</span><span>P token ${addressLink(event.pToken)}</span><span>N token ${addressLink(event.nToken)}</span><span>Sale ID ${e(event.saleId.toString())}</span><span>Tx ${txLink(result.tx.hash)}</span></div>`
  localStorage.removeItem(STORAGE_KEY)
  update()
}

/* ---------- Lend ---------- */
function renderLend() {
  const rows = liveOpenMarkets().sort((a, b) => estimatedApr(b) - estimatedApr(a))
  const selected = selectedMarket()
  $('view').innerHTML = `<section class="lend-layout"><div class="card table-card"><div class="card-head"><h2>Open positions</h2><span>${rows.length} live</span></div><div class="table-tools"><div class="search-input"><span>⌕</span><input placeholder="Search collateral"></div><button class="sort">Sorted by APR</button></div><div class="pos-list">${loadingPositions ? '<div class="empty-state">Loading live positions…</div>' : rows.length ? rows.map(lendCard).join('') : lendEmptyState()}</div></div><aside><div class="card action-card" id="lendPreview"></div><div class="card split-card"><button id="toggleHow" class="how-toggle">How it works <span>${howOpen ? '−' : '+'}</span></button><div class="how-body" ${howOpen ? '' : 'hidden'}>${splitModule('lend')}</div></div></aside></section>`
  document.querySelectorAll('[data-select-market]').forEach((b) => b.onclick = () => { selectedLendId = b.dataset.selectMarket; renderLend() })
  $('goBorrow')?.addEventListener('click', () => { activeTab = 'borrow'; render() })
  $('lendPreview').innerHTML = selected ? lendPreview(selected) : '<h2>Lend into a position</h2><p class="hint">Pick a position on the left to fund it. Live listings appear here as borrowers open them.</p>'
  $('fundPosition')?.addEventListener('click', () => fundSelected(selected))
  $('budgetUsdc')?.addEventListener('input', () => updateBudgetQuote(selected))
  $('toggleHow')?.addEventListener('click', () => { howOpen = !howOpen; renderLend() })
}
function lendEmptyState() {
  return `<div class="empty-state"><h3>No live positions yet</h3><p>Be the first to put capital to work here, or open your own position and set the terms lenders see.</p><button id="goBorrow" class="ghost-cta">Create a position →</button></div>`
}
function lendCard(m) {
  const fill = Math.min(100, fillPct(m))
  return `<button class="pos-card ${m.id === selectedLendId ? 'selected' : ''}" data-select-market="${e(m.id)}"><div class="pos-top"><span class="asset-cell">${tokenIcon(m.token, m.collateral)}<span><strong>${e(m.token)}</strong><small>${shortAddress(m.collateral)}</small></span></span><span class="apr-pill">${estimatedApr(m).toFixed(1)}%<small>est. APR</small></span></div><div class="pos-grid"><div><label>Raise</label><strong>${e(fmt(m.targetRaiseUsdc, 6, 2))}</strong></div><div><label>Repays</label><strong>${e(fmt(m.totalRepaymentUsdc, 6, 2))}</strong></div><div><label>Available</label><strong>${e(fmt(m.sale.amountRemaining, m.decimals, 2))} P</strong></div><div><label>Funding ends</label><strong>${formatDate(m.fundingDeadline)}</strong></div></div><div class="bar"><span style="width:${fill}%"></span></div><div class="pos-foot"><small>${fill.toFixed(0)}% funded</small><span class="cta">Lend →</span></div></button>`
}
function lendPreview(m) {
  const fee = m.sale.usdcRemaining ? (m.sale.usdcRemaining * CONFIG.SALE_FEE_BPS) / 10000n : 0n
  return `<h2>Lend into ${e(m.token)}</h2><div class="asset-large">${tokenIcon(m.token, m.collateral)}<div><strong>${e(m.token)}</strong><small>${shortAddress(m.collateral)}</small></div></div>${previewRows([['Estimated APR', `<span class="green">${estimatedApr(m).toFixed(1)}%</span>`], ['P available', `${e(fmt(m.sale.amountRemaining, m.decimals, 4))} P`], ['USDC remaining', `${e(fmt(m.sale.usdcRemaining, 6, 2))} USDC`], ['Total repayment', `${e(fmt(m.totalRepaymentUsdc, 6, 2))} USDC`], ['Funded', `${fillPct(m).toFixed(1)}%`], ['Repayment deadline', formatDate(m.repaymentDeadline)], ['Marketplace fee (est.)', `${e(fmt(fee, 6, 4))} USDC`], ['Vault', addressLink(m.vault)]])}<div class="two-cols"><div><label>P amount</label><div class="unit-input"><input id="pAmount" inputmode="decimal" placeholder="0"></div></div><div><label>Max USDC budget</label><div class="unit-input"><input id="budgetUsdc" inputmode="decimal" placeholder="0"><span>USDC</span></div></div></div><div id="budgetQuote" class="budget-quote"></div><button id="fundPosition" class="primary-action" ${isWriteDisabled({ wrongNetwork: account && !isBase(), pending }) || factoryState.purchasesPaused ? 'disabled' : ''}>Fund position</button>`
}
async function updateBudgetQuote(m) {
  if (!m) return
  const budget = parseAmount($('budgetUsdc').value, 6)
  if (!budget) return $('budgetQuote').textContent = ''
  const mp = marketplace(true)
  const best = await pAmountForBudget({ high: m.sale.amountRemaining, budget, quoteTotalPayment: async (p) => (await mp.quoteTotalPayment(m.saleId, p))[2] })
  $('pAmount').value = plain(best, m.decimals)
  $('budgetQuote').textContent = `Largest P within budget: ${fmt(best, m.decimals, 6)} P`
}
async function fundSelected(m) {
  if (!m) return
  if (!account) return setNoticeText('Connect your wallet to fund a position.', true)
  if (!isBase()) return setNoticeText('Switch to Base before funding.', true)
  if (factoryState.purchasesPaused) return setNoticeText('New marketplace purchases are paused.', true)
  const pAmount = parseAmount($('pAmount').value, m.decimals)
  const budget = parseAmount($('budgetUsdc').value, 6)
  if (!pAmount || !budget) return setNoticeText('Enter a P amount and a maximum USDC budget.', true)
  const mpRead = marketplace(true)
  const sale = saleTuple(await mpRead.sales(m.saleId))
  if (!sale.active || sale.amountRemaining < pAmount || BigInt(nowSec()) >= sale.expiry) return setNoticeText('This sale is no longer available.', true)
  let quote = await mpRead.quoteTotalPayment(m.saleId, pAmount)
  if (quote[2] > budget) return setNoticeText('The current quote is above your budget. Lower the P amount and try again.', true)
  const usdc = erc20(CONFIG.BASE_USDC, false)
  const allowance = await usdc.allowance(account, CONFIG.MARKETPLACE_ADDRESS)
  if (allowance < quote[2]) await sendTx('Approve USDC', async () => usdc.approve(CONFIG.MARKETPLACE_ADDRESS, quote[2]))
  quote = await marketplace(true).quoteTotalPayment(m.saleId, pAmount)
  if (quote[2] > budget) return setNoticeText('The quote moved above your budget after approval. No purchase was sent.', true)
  await sendTx('Fund position', async () => marketplace(false).buy(m.saleId, pAmount, quote[2]))
}

/* ---------- Portfolio ---------- */
function renderPortfolio() {
  const borrowerRows = account ? markets.filter((m) => m.borrower.toLowerCase() === account.toLowerCase()) : []
  const lenderRows = account ? markets.filter((m) => m.pBalance > 0n) : []
  $('view').innerHTML = `<section class="portfolio"><div class="card table-card"><div class="card-head"><h2>Your borrow positions</h2></div>${borrowerRows.length ? portfolioTable(['Collateral', 'Funded', 'USDC received', 'Repayment due', 'Status', 'Action'], borrowerRows.map(borrowerRow)) : `<div class="empty-state"><h3>No borrow positions</h3><p>${account ? 'Open a position to raise USDC against your tokens.' : 'Connect your wallet to see positions you have created.'}</p>${account ? '<button id="goBorrow2" class="ghost-cta">Create a position →</button>' : ''}</div>`}</div><div class="card table-card"><div class="card-head"><h2>Your lend positions</h2></div>${lenderRows.length ? portfolioTable(['Collateral', 'P balance', 'Redeem preview', 'Deadline', 'Status', 'Action'], lenderRows.map(lenderRow)) : `<div class="empty-state"><h3>No lend positions</h3><p>${account ? 'Positions you fund will show up here with their redeem actions.' : 'Connect your wallet to track positions you have funded.'}</p>${account ? '<button id="goLend2" class="ghost-cta">Browse positions →</button>' : ''}</div>`}</div></section>`
  document.querySelectorAll('[data-action]').forEach((b) => b.onclick = () => portfolioAction(b.dataset.action, b.dataset.vault))
  $('goBorrow2')?.addEventListener('click', () => { activeTab = 'borrow'; render() })
  $('goLend2')?.addEventListener('click', () => { activeTab = 'lend'; render() })
}
function statusFor(m) { if (m.settled) return 'Redeemable'; if (m.fundingClosed) return 'Repayment'; if (m.sale?.active) return 'Funding'; return 'Open' }
function borrowerRow(m) {
  const received = (m.targetRaiseUsdc * m.funded) / (m.initialCollateralAmount || 1n)
  return [asset(m), `${fillPct(m).toFixed(1)}%`, `${fmt(received, 6, 2)} USDC`, `${fmt(m.repaymentRequiredUsdc, 6, 2)} USDC`, badge(statusFor(m)), actionButtons(m, 'borrower')]
}
function lenderRow(m) {
  const preview = m.settled ? `${fmt(m.preview.usdcOut, 6, 2)} USDC · ${fmt(m.preview.collateralOut, m.decimals, 4)} ${e(m.token)}` : 'After settlement'
  return [asset(m), `${fmt(m.pBalance, m.decimals, 4)} P`, preview, formatDate(m.repaymentDeadline), badge(statusFor(m)), actionButtons(m, 'lender')]
}
function actionButtons(m, role) {
  const buttons = []
  if (role === 'borrower' && m.sale?.active) buttons.push(['cancel', 'Cancel sale'])
  if (role === 'borrower' && m.sale?.active && BigInt(nowSec()) >= m.sale.expiry) buttons.push(['closeExpired', 'Close expired'])
  if (role === 'borrower' && m.collateralRefundClaim > 0n) buttons.push(['claimRefund', 'Claim refund'])
  if (role === 'borrower' && m.fundingClosed && !m.settled && m.repaymentRemainingUsdc > 0n && BigInt(nowSec()) <= m.repaymentDeadline) buttons.push(['repay', 'Repay in full'])
  if (!m.settled && (m.canSettleEarly || BigInt(nowSec()) > m.repaymentDeadline)) buttons.push(['settle', 'Settle'])
  if (role === 'borrower' && m.pBalance > 0n && m.nBalance >= m.pBalance && m.fundingClosed && !m.settled) buttons.push(['redeemPair', 'Redeem P+N'])
  if (role === 'lender' && m.settled && m.pBalance > 0n) buttons.push(['redeemP', 'Redeem'])
  if (role === 'lender' && !m.settled && m.pBalance > 0n) buttons.push(['settleRedeem', 'Settle + redeem'])
  return buttons.length ? `<span class="row-actions">${buttons.map(([action, label]) => `<button class="link-btn" data-action="${action}" data-vault="${e(m.vault)}">${label}</button>`).join('')}</span>` : '<span class="hint">Nothing to do yet</span>'
}
async function portfolioAction(action, vaultAddress) {
  const m = markets.find((x) => x.vault === vaultAddress)
  if (!m || !account) return
  if (!isBase()) return setNoticeText('Switch to Base before sending a transaction.', true)
  const v = vaultContract(vaultAddress, false)
  if (action === 'cancel') return sendTx('Cancel sale', () => marketplace(false).cancel(m.saleId))
  if (action === 'closeExpired') return sendTx('Close expired sale', () => marketplace(false).closeExpired(m.saleId))
  if (action === 'claimRefund') return sendTx('Claim collateral refund', () => v.claimCollateralRefund(account))
  if (action === 'repay') {
    const usdc = erc20(CONFIG.BASE_USDC, false)
    const needed = await vaultContract(vaultAddress, true).repaymentRemainingUsdc()
    if ((await usdc.allowance(account, vaultAddress)) < needed) await sendTx('Approve repayment USDC', () => usdc.approve(vaultAddress, needed))
    return sendTx('Repay in full', () => v.repayInFull())
  }
  if (action === 'settle') return sendTx('Settle position', () => v.settle())
  if (action === 'redeemPair') return sendTx('Redeem matching P and N', () => v.redeemPair(m.pBalance < m.nBalance ? m.pBalance : m.nBalance))
  if (action === 'redeemP') return sendTx('Redeem P', () => v.redeemP(m.pBalance))
  if (action === 'settleRedeem') return sendTx('Settle and redeem P', () => v.settleAndRedeemP(m.pBalance))
}

/* ---------- Shared bits ---------- */
function asset(p) { return `<span class="asset-cell">${tokenIcon(p.token, p.collateral)}<span><strong>${e(p.token)}</strong><small>${shortAddress(p.collateral)}</small></span></span>` }
function badge(statusText) { return `<span class="badge ${e(statusText.toLowerCase())}">${e(statusText)}</span>` }
function portfolioTable(head, rows) { return `<div class="portfolio-table"><div class="portfolio-head">${head.map((h) => `<span>${e(h)}</span>`).join('')}</div>${rows.map((r) => `<div class="portfolio-row">${r.map((c) => `<span>${c}</span>`).join('')}</div>`).join('')}</div>` }
function splitModule(mode) {
  if (mode === 'lend') return `<div class="lend-flow"><div class="lend-step"><strong>1</strong><span>Fund with USDC</span><small>Provide USDC to fund a position and receive P.</small></div><div class="lend-step"><strong>2</strong><span>Hold P</span><small>P is your claim to the agreed fixed repayment.</small></div><div class="outcome-stack"><div><strong class="green">If the borrower repays</strong><small>Redeem P for the agreed USDC — your fixed yield.</small></div><div><strong class="violet">If they do not</strong><small>Redeem P for the locked collateral instead.</small></div></div></div>`
  const steps = [['Lock your collateral', 'Deposit your token to open the position.'], ['It splits into P and N', 'Two linked tokens are minted against your collateral.'], ['Sell P for USDC', 'Selling the P claim is how the raise reaches your wallet.'], ['Keep N to reclaim', 'N is your right to repay and unlock the collateral.']]
  return `<div class="split-module"><div class="split-diagram"><div class="split-top">Your collateral</div><div class="split-line"></div><div class="split-legs"><div class="leg-p"><strong>P</strong><span>Sold for USDC</span><small>Lender's claim</small></div><div class="leg-n"><strong>N</strong><span>Kept to reclaim</span><small>Your right</small></div></div></div><div class="split-copy"><ol>${steps.map(([title, copy]) => `<li><strong>${e(title)}</strong><span>${e(copy)}</span></li>`).join('')}</ol><div class="outcomes"><div><strong class="green">Repay by the deadline</strong><span>you get your collateral back in full.</span></div><div><strong class="violet">Miss the deadline</strong><span>lenders redeem the collateral instead. No liquidation in between.</span></div></div></div></div>`
}
function previewRows(rows) { return `<div class="preview-rows">${rows.map(([k, v]) => `<div><span>${e(k)}</span><strong>${v}</strong></div>`).join('')}</div>` }

async function boot() {
  app.innerHTML = '<div class="shell"><div class="notice">Loading the PMFI interface…</div></div>'
  if (window.ethereum) {
    browserProvider = new BrowserProvider(window.ethereum)
    const accounts = await browserProvider.send('eth_accounts', []).catch(() => [])
    chainId = Number((await browserProvider.getNetwork().catch(() => ({ chainId: 0n }))).chainId)
    if (accounts[0]) { signer = await browserProvider.getSigner(); account = await signer.getAddress() }
    setupWalletEvents()
  }
  await refreshAll()
  await render()
}
boot().catch((error) => { app.innerHTML = `<div class="shell"><div class="notice danger"><strong>Could not start the interface.</strong> ${sanitizeError(error)}</div></div>` })
