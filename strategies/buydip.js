var bp = require('../bitprophet.js')

var intervalsValidation = ["1h", "5m"]
var intervalsWatch = ["1h", "15m", "5m"]

module.exports = {
    resetPairCustomData: function(pair) {
        pair.tryBuyTimestamp = null
        pair.trySellTimestamp = null
        pair.warningSilent = false
    },
    checkValidWorkingPair: function(strategy, pair) {
        function setPairValid(valid) {
            if(valid) {
                if(pair.status == -1) pair.functions.addWatcherChartUpdates(intervalsWatch)
                pair.status = 0
            }
            else {
                if(pair.status == 0) pair.functions.removeWatcherChartUpdates(intervalsWatch)
                pair.status = -1
            }
        }

        if(pair.functions.chartsNeedUpdate(intervalsValidation, 60, true)) return

        pair.lastValidCheck = Date.now()

        var chart1h = pair.functions.chart("1h").ticks
        var chart5m = pair.functions.chart("5m").ticks

        if(chart1h.length < 500 || chart5m.length < 500) {
            setPairValid(false)
            return
        }

        var close1h = parseFloat(chart1h[chart1h.length - 1].close)
        var stoch1h = bp.indicators.stochastic(chart1h, 14, 11)
        var stoch1hAvg = bp.indicators.average(stoch1h)
        var stoch5m = bp.indicators.stochastic(chart5m, 14, 24)
        var stoch5mAvg = bp.indicators.average(stoch5m)
        var maxDiff5m = bp.indicators.measureMaxDiff(chart5m, 120)
        var volume24h = bp.indicators.volume24h(chart1h, 60)

        setPairValid(volume24h >= 100 && stoch1hAvg > 30 && stoch5mAvg >= 20 && maxDiff5m < 100)
    },
    process: function(strategy, pair) {
        if(!pair.functions.chartUpdatesActive(intervalsWatch)) {
            pair.functions.ensureChartUpdates(intervalsWatch)
            return
        }

        var order = strategy.order(pair.name, "BUY")
        if(order && order.partFill == 1) {
            if(pair.status == 1) pair.status = 2
            order.waiting = false
        }

        order = strategy.order(pair.name, "SELL")
        if(order && order.partFill == 1) {
            pair.status = 4
            order.waiting = false
        }

        switch(pair.status) {
        case 0:
            this.initialAnalysis(strategy, pair)
            break
        case 1:
            this.waitForBuyOrder(strategy, pair)
            break
        case 2:
            this.setupSellOrder(strategy, pair)
            break
        case 3:
            this.manageSellOrder(strategy, pair)
            break
        case 4:
        default:
            strategy.tradeFinished(pair)
            break
        }
    },
    initialAnalysis: function(strategy, pair) {
        function placeOrder(price) {
            if(pair.tryBuyTimestamp && Date.now() - pair.tryBuyTimestamp < 10 * 1000) return
            pair.tryBuyTimestamp = Date.now()

            pair.processing = true
            bp.exchUtils.createBuyOrder(pair.name, parseFloat(price).toFixed(8), strategy.buyAmountBTC(), function(error, orderId, quantity, filled) {
                pair.processing = false

                if(error) {
                    console.log("Error placing buy order", pair.name, error)
                    pair.lastBase = null
                    return
                }

                strategy.sendMessage(pair, "trading started", "beginner")

                pair.entryPrice = parseFloat(price)
                pair.sellTarget = pair.entryPrice * (1 + strategy.profitTarget())

                var order = strategy.createOrder(pair.name, orderId, "BUY", parseFloat(price), parseFloat(quantity))

                if(filled) {
                    pair.amountToSell = order.amount
                    order.partFill = 1
                    order.waiting = false
                    pair.status = 2
                }
                else {
                    pair.warningSilent = false
                    pair.status++
                }
            })
        }

        var chart1h = pair.functions.chart(intervalsWatch[0]).ticks
        var chart15m = pair.functions.chart(intervalsWatch[1]).ticks
        var chart5m = pair.functions.chart(intervalsWatch[2]).ticks

        if(chart1h.length < 500 || chart15m.length < 500 || chart5m.length < 500) return

        var lastClose = parseFloat(chart5m[chart5m.length - 1].close)
        var rsi5m = bp.indicators.rsi(chart5m, 14, 100, 1)
        var stoch1h = bp.indicators.stochastic(chart1h, 14, 3)
        var stoch15m = bp.indicators.stochastic(chart15m, 14, 3)
        var stoch5m = bp.indicators.stochastic(chart5m, 14, 3)
        rsi5m = rsi5m[0]
        stoch1h = bp.indicators.average(stoch1h)
        stoch15m = bp.indicators.average(stoch15m)
        stoch5m = bp.indicators.average(stoch5m)

        if(stoch1h < 45 && stoch5m < 20 && ((rsi5m < 26 && stoch15m < 15) || (rsi5m < 21 && stoch15m < 30))) {
            placeOrder(lastClose)
        }
    },
    waitForBuyOrder: function(strategy, pair) {
        var order = strategy.order(pair.name, "BUY")
        if(!order) {
            pair.status--
            return
        }

        //Wait 3min for order to be traded
        var diffTime = Date.now() - order.timestamp

        if(diffTime > 3 * 60 * 1000 || bp.vars.btcAnalysis.dangerZone) {
            var filledAmount = order.amount * pair.partFill
            var boughtPart = order.partFill > 0
            var enoughForNewOrder = order.partFill * strategy.buyAmountBTC() >= bp.vars.minTradeAmount

            if(boughtPart && !enoughForNewOrder) {
                if(!pair.warningSilent) {
                    pair.warningSilent = true
                    strategy.sendMessage(pair, "can't cancel order, amount bought not enough to be sold", "warning")
                }
                return
            }

            pair.processing = true
            bp.exchUtils.cancelOrder(pair.name, order.id, function(error) {
                pair.processing = false
                if(error) {
                    console.log("Error canceling buy order", error)
                    return
                }

                order.canceled = true
                order.waiting = false

                if(boughtPart) {
                    pair.status++
                }
                else {
                    pair.tryBuyTimestamp = Date.now()
                    pair.status--
                }
            })
        }
    },
    setupSellOrder: function(strategy, pair) {
        pair.processing = true
        bp.exchUtils.createSellOrder(pair.name, parseFloat(pair.sellTarget).toFixed(8), pair.amountToSell, function(error, orderId, filled) {
            pair.processing = false

            if(error) {
                console.log("Error placing sell order", pair.name, error)
                return
            }

            var order = strategy.createOrder(pair.name, orderId, "SELL", parseFloat(pair.sellTarget), pair.amountToSell)

            if(filled) {
                pair.amountToSell -= order.amount
                order.partFill = 1
                pair.status = 4
            }
            else {
                pair.stopLoss.stopPrice = pair.entryPrice * (1 - strategy.maxLoss() * 0.9)
                pair.stopLoss.sellPrice = pair.entryPrice * (1 - strategy.maxLoss())
                pair.warningSilent = false
                pair.status++
            }
        })
    },
    manageSellOrder: function(strategy, pair) {
        var order = strategy.order(pair.name, "SELL")
        if(!order && !pair.forceSell) {
            pair.status--
            return
        }

        function recreateSellOrder() {
            pair.processing = true
            bp.exchUtils.cancelOrder(pair.name, order ? order.id : null, function(error) {
                if(error) {
                    console.log("Error canceling sell order", pair.name, error)
                }

                if(order) {
                    order.canceled = true
                    order.waiting = false
                }

                bp.exchUtils.createSellOrder(pair.name, pair.sellTarget, pair.amountToSell, function(error, orderId, filled) {
                    pair.processing = false
                    if(error) {
                        console.log("Error creating sell order", pair.name, error)
                        return
                    }

                    var order = strategy.createOrder(pair.name, orderId, "SELL", parseFloat(pair.sellTarget).toFixed(8), pair.amountToSell)

                    if(filled) {
                        pair.amountToSell -= order.amount
                        order.partFill = 1
                        order.waiting = false
                        pair.status = 4
                    }
                })
            })
        }

        if(pair.forceSell) {
            recreateSellOrder()
            pair.forceSell = false
            return
        }

        var sellOrderAmount = parseFloat(bp.exchUtils.normalizeAmount(pair.name, order.amount * (1 - order.partFill)))
        var amountToSell = parseFloat(bp.exchUtils.normalizeAmount(pair.name, pair.amountToSell))
        if(order.price.toFixed(8) != pair.sellTarget.toFixed(8) || amountToSell > sellOrderAmount) {
            if(pair.trySellTimestamp && Date.now() - pair.trySellTimestamp < 5 * 1000) return
            pair.trySellTimestamp = Date.now()
            recreateSellOrder()
        }
        else {
            var chart5m = pair.functions.chart(intervalsWatch[2]).ticks
            var lastClose = parseFloat(chart5m[chart5m.length - 1].close)

            var activateStopLoss = strategy.manageStopLoss(pair, lastClose)
            if(activateStopLoss) recreateSellOrder()
        }
    }
}
