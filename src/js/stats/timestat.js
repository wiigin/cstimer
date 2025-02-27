"use strict";

var TimeStat = execMain(function() {

	function TimeStat(avgSizes, timesLen, timeAt, timeSort) {
		this.avgSizes = avgSizes.slice();
		this.timeAt = timeAt;
		this.timeSort = timeSort || TimeStat.dnfsort;
		this.reset(timesLen);
	}

	function getNTrim(n) {
		var ntrim = kernel.getProp('trim', 'p5');
		if (ntrim[0] == 'p') {
			return Math.ceil(n / 100 * ntrim.slice(1));
		} else if (ntrim == 'm') {
			return Math.max(0, (n - 1) >> 1);
		} else {
			return ~~ntrim;
		}
	}

	TimeStat.dnfsort = function(a, b) {
		if (a == b) return 0;
		if (a < 0) return 1;
		if (b < 0) return -1;
		return a - b;
	}

	TimeStat.prototype.reset = function(timesLen) {
		this.timesLen = timesLen;
		this.shouldRecalc = true;
	}

	TimeStat.prototype.getAllStats = function() {
		this.genStats();
		var numdnf = this.timesLen - this.tree.rankOf(-1);
		return [numdnf, (numdnf == this.timesLen) ? -1 : this.tree.cumSum(this.timesLen - numdnf) / (this.timesLen - numdnf)];
	}

	TimeStat.prototype.genStats = function() {
		if (!this.shouldRecalc) {
			return;
		}
		this._bestAvg = [];
		this.lastAvg = [];
		this.treesAvg = [];
		this.tree = sbtree.tree(this.timeSort);
		this.bestTime = this.worstTime = -1;
		this.bestTimeIndex = this.worstTimeIndex = 0;

		var curTimesLen = this.timesLen;
		this.timesLen = 0;
		this.toLength(curTimesLen);
		this.shouldRecalc = false;
	}

	TimeStat.prototype.pushed = function(silent) {
		this.genStats(); // make sure all statistics are available, then update
		this.doPushed(silent);
	}

	TimeStat.prototype.bestAvg = function(idx, subIdx) {
		var arr = this._bestAvg[idx] || [];
		var ret = arr[arr.length - 1] || [-1, 0, -1, -1, 0];
		if (subIdx !== undefined) {
			return ret[subIdx];
		}
		return ret;
	}

	TimeStat.prototype.doPushed = function(silent, next) {
		var bestHintList = [];

		this.timesLen++;
		var i = this.timesLen - 1;
		var t = this.timeAt(i);
		this.tree.insert(t, i);

		if (!next) {
			var prevBest = this.bestTime;
			this.bestTime = this.timesLen == 0 ? -1 : this.tree.rank(0);
			this.bestTimeIndex = this.tree.find(this.bestTime);
			this.worstTime = this.timesLen == 0 ? -1 : this.tree.rank(Math.max(0, this.tree.rankOf(-1) - 1));
			this.worstTimeIndex = this.tree.find(this.worstTime);

			if (this.timeSort(t, prevBest) < 0 && prevBest != -1) {
				bestHintList.push('single');
			}
		}

		for (var j = 0; j < this.avgSizes.length; j++) {
			var size = Math.abs(this.avgSizes[j]);
			if (this.timesLen < size) {
				break;
			}
			var trim = this.avgSizes[j] < 0 ? 0 : getNTrim(size);
			var neff = size - 2 * trim;
			var rbt = this.treesAvg[j] || sbtree.tree(this.timeSort);
			if (this.timesLen == size) {
				for (var k = 0; k < size; k++) {
					rbt.insert(this.timeAt(k), k);
				}
				this._bestAvg[j] = [];
			} else {
				rbt.remove(this.timeAt(i - size)).insert(t, i);
			}
			var sum = rbt.cumSum(size - trim) - rbt.cumSum(trim);
			var variance = Math.sqrt((rbt.cumSk2(size - trim) - rbt.cumSk2(trim) - sum * sum / neff) / (neff - 1)) / 1000;
			var curVal = [(rbt.rankOf(-1) < size - trim) ? -1 : sum / neff, variance, rbt.rank(trim - 1), rbt.rank(size - trim)];
			if (this.timeSort(curVal[0], this.bestAvg(j, 0)) < 0) {
				if (this.bestAvg(j, 0) >= 0 && !next) {
					bestHintList.push((this.avgSizes[j] > 0 ? "ao" : "mo") + size);
				}
				this._bestAvg[j].push(curVal.concat([i - size + 1]));
			}
			this.lastAvg[j] = curVal;
			this.treesAvg[j] = rbt;
		}
		if (bestHintList.length != 0 && !silent) {
			logohint.push("Session best " + bestHintList.join(" ") + "!");
		}
	}

	// pop or push solves
	TimeStat.prototype.toLength = function(target) {
		while (this.timesLen > target) {
			this.toPop(this.timesLen - 1 != target);
		}
		while (this.timesLen < target) {
			this.doPushed(true, this.timesLen + 1 != target);
		}
	}

	TimeStat.prototype.toPop = function(next) {
		var i = this.timesLen - 1;
		var t = this.timeAt(i);
		this.tree.remove(t);
		if (!next) {
			this.bestTime = this.timesLen == 0 ? -1 : this.tree.rank(0);
			this.bestTimeIndex = this.tree.find(this.bestTime);
			this.worstTime = this.timesLen == 0 ? -1 : this.tree.rank(Math.max(0, this.tree.rankOf(-1) - 1));
			this.worstTimeIndex = this.tree.find(this.worstTime);
		}
		for (var j = 0; j < this.avgSizes.length; j++) {
			var size = Math.abs(this.avgSizes[j]);
			if (this.timesLen < size) {
				break;
			} else if (this.timesLen == size) {
				this.lastAvg[j] = null;
				this.treesAvg[j] = null;
				this._bestAvg[j] = null;
				continue;
			}
			var rbt = this.treesAvg[j];
			rbt.remove(t).insert(this.timeAt(i - size), i - size);
			if (!next) {
				var trim = this.avgSizes[j] < 0 ? 0 : getNTrim(size);
				var neff = size - 2 * trim;
				var sum = rbt.cumSum(size - trim) - rbt.cumSum(trim);
				var variance = Math.sqrt((rbt.cumSk2(size - trim) - rbt.cumSk2(trim) - sum * sum / neff) / (neff - 1)) / 1000;
				var curVal = [(rbt.rankOf(-1) < size - trim) ? -1 : sum / neff, variance, rbt.rank(trim - 1), rbt.rank(size - trim)];
				this.lastAvg[j] = curVal;
			}
			if (this.bestAvg(j, 4) == i - size + 1) {
				this._bestAvg[j].pop();
			}
		}
		this.timesLen--;
	}

	// threshold to break best, -1 => never, -2 => always
	TimeStat.prototype.getThres = function() {
		var thres = [];
		for (var j = 0; j < this.avgSizes.length; j++) {
			var size = Math.abs(this.avgSizes[j]);
			if (this.timesLen < size) {
				break;
			}
			var trim = this.avgSizes[j] < 0 ? 0 : getNTrim(size);
			var neff = size - 2 * trim;
			var rbt = this.treesAvg[j] || sbtree.tree(this.timeSort);
			var toRemove = this.timeAt(this.timesLen - size);
			var left = trim;
			var right = size - trim - 1;
			if (this.timeSort(toRemove, rbt.rank(left)) < 0) {
				left += 1;
				toRemove = 0;
			} else if (this.timeSort(rbt.rank(right), toRemove) < 0) {
				right -= 1;
				toRemove = 0;
			}
			var tgtAvg = this.bestAvg(j, 0);
			if (rbt.rankOf(-1) < right) { //next avg is always DNF
				thres[j] = -1;
				continue;
			} else if (tgtAvg == -1) {
				thres[j] = -2;
				continue;
			}
			var sum = rbt.cumSum(right + 1) - rbt.cumSum(left) - toRemove;
			var tgt = tgtAvg * neff - sum;
			var minVal = left == 0 ? 0 : rbt.rank(left - 1);
			var maxVal = right == size - 1 ? -1 : rbt.rank(right + 1);
			if (tgt <= 0 || this.timeSort(tgt, minVal) < 0) {
				thres[j] = -1;
			} else if (this.timeSort(maxVal, tgt) < 0) {
				thres[j] = -2;
			} else {
				thres[j] = tgt;
			}
		}
		return thres;
	}

	TimeStat.prototype.getMinMaxInt = function() {
		var theStats = this.getAllStats();
		if (theStats[0] == this.timesLen) {
			return null;
		}
		return [this.worstTime, this.bestTime, this.getBestDiff(this.worstTime - this.bestTime)];
	}

	TimeStat.prototype.getBestDiff = function(gap) {
		var diffValues = [100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000];
		var diff;
		if (kernel.getProp('disPrec') == 'a') {
			diff = gap / 10;
			for (var i = 0; i < diffValues.length; i++) {
				if (diff < diffValues[i]) {
					diff = diffValues[i];
					break;
				}
			}
		} else {
			diff = diffValues[kernel.getProp('disPrec')];
		}
		return diff;
	}

	//ret length: length - nsolves + 1
	TimeStat.prototype.runAvgMean = function(start, length, size, trim) {
		size = size || length;
		if (trim === undefined) {
			trim = getNTrim(size);
		}
		if (start < 0 || start + length > this.timesLen) {
			return;
		}
		if (size - trim <= 0) {
			return [-1, 0, -1, -1];
		}
		var rbt = sbtree.tree(this.timeSort);
		for (var j = 0; j < size; j++) {
			rbt.insert(this.timeAt(start + j), j);
		}
		var neff = size - 2 * trim;
		var sum = rbt.cumSum(size - trim) - rbt.cumSum(trim);
		var variance = Math.sqrt((rbt.cumSk2(size - trim) - rbt.cumSk2(trim) - sum * sum / neff) / (neff - 1)) / 1000;
		var ret = [
			[(rbt.rankOf(-1) < size - trim) ? -1 : sum / neff, variance, rbt.rank(trim - 1), rbt.rank(size - trim)]
		];
		var start0 = start - size;
		for (var i = size; i < length; i++) {
			rbt.remove(this.timeAt(start0 + i)).insert(this.timeAt(start + i), j);
			sum = rbt.cumSum(size - trim) - rbt.cumSum(trim);
			variance = Math.sqrt((rbt.cumSk2(size - trim) - rbt.cumSk2(trim) - sum * sum / neff) / (neff - 1)) / 1000;
			ret.push([(rbt.rankOf(-1) < size - trim) ? -1 : sum / neff, variance, rbt.rank(trim - 1), rbt.rank(size - trim)]);
		}
		return ret;
	}

	TimeStat.prototype.getTrimList = function(start, nsolves, thresL, thresR) {
		var trimlList = [];
		var trimrList = [];
		var trim = getNTrim(nsolves);
		for (var i = 0; i < nsolves; i++) {
			var t = this.timeAt(start + i);
			var cmpl = this.timeSort(t, thresL);
			var cmpr = this.timeSort(thresR, t);
			if (cmpl < 0) {
				trimlList.push(i);
			} else if (cmpr < 0) {
				trimrList.push(i);
			} else if (cmpl == 0 && trimlList.length < trim) {
				trimlList.unshift(i);
			} else if (cmpr == 0 && trimrList.length < trim) {
				trimrList.unshift(i);
			}
		}
		return trimlList.slice(-trim).concat(trimrList.slice(-trim));
	}

	return TimeStat;
});
