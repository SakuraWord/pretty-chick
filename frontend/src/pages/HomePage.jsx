import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Card,
  Tabs,
  Button,
  Modal,
  Form,
  Input,
  message,
  Popconfirm,
  Empty,
  Spin,
  Table,
  Space,
  AutoComplete,
  Typography,
  Grid,
  Radio,
  Statistic,
  Row,
  Col,
  theme,
} from 'antd';
import {
  PlusOutlined,
} from '@ant-design/icons';
import ReactECharts from 'echarts-for-react';
import { watchlistsAPI, fundsAPI, positionsAPI } from '../api';
import { usePreference } from '../contexts/PreferenceContext';

const { Text } = Typography;
const { useBreakpoint } = Grid;

const SOURCE_OPTIONS = [
  { label: '东方财富', value: 'eastmoney' },
  { label: '养基宝', value: 'yangjibao' },
  { label: '小倍养基', value: 'xiaobeiyangji' },
];

const HomePage = () => {
  const screens = useBreakpoint();
  const isMobile = !screens.md;
  const { token } = theme.useToken();
  const { preferredSource, updatePreference } = usePreference();

  // --- index行情 ---
  const [indices, setIndices] = useState([]);

  // --- 自选列表 ---
  const [watchlists, setWatchlists] = useState([]);
  const [selectedWatchlistId, setSelectedWatchlistId] = useState(null);
  const [loading, setLoading] = useState(false);
  const [fundsData, setFundsData] = useState([]);
  const [fundsLoading, setFundsLoading] = useState(false);
  const [searchKeyword, setSearchKeyword] = useState('');
  const [fundOptions, setFundOptions] = useState([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [form] = Form.useForm();
  const [groupGrowths, setGroupGrowths] = useState({});

  // --- 选中基金详情 ---
  const [selectedFund, setSelectedFund] = useState(null);
  const [navHistory, setNavHistory] = useState([]);
  const [chartLoading, setChartLoading] = useState(false);
  const [timeRange, setTimeRange] = useState('1M');
  const [positions, setPositions] = useState([]);
  const [operations, setOperations] = useState([]);

  // --- 移动端 Tab ---
  const [mobileTab, setMobileTab] = useState('watchlist');

  // --- 定时器 ---
  const intervalRef = useRef(null);

  // ref 用于 loadWatchlists 闭包中读取最新 selectedWatchlistId
  const selectedWatchlistIdRef = useRef(selectedWatchlistId);
  useEffect(() => { selectedWatchlistIdRef.current = selectedWatchlistId; }, [selectedWatchlistId]);

  // ==================== 加载指数行情 ====================
  const loadIndices = useCallback(async () => {
    try {
      const { data } = await fundsAPI.marketIndices();
      setIndices(data.indices || []);
    } catch {}
  }, []);

  // ==================== 加载自选列表 ====================
  const loadWatchlists = useCallback(async () => {
    setLoading(true);
    try {
      const response = await watchlistsAPI.list();
      setWatchlists(response.data);
      if (response.data.length > 0 && !selectedWatchlistIdRef.current) {
        setSelectedWatchlistId(response.data[0].id);
      }
    } catch (error) {
      message.error('加载自选列表失败');
    } finally {
      setLoading(false);
    }
  }, []);

  // ==================== 创建 / 删除自选列表 ====================
  const handleCreate = async () => {
    try {
      const values = await form.validateFields();
      await watchlistsAPI.create(values);
      message.success('创建成功');
      form.resetFields();
      setModalVisible(false);
      loadWatchlists();
    } catch (error) {
      if (error.errorFields) return;
      message.error('创建失败');
    }
  };

  // ==================== 加载基金详情（净值/估值） ====================
  const loadFundDetails = useCallback(async () => {
    const currentWatchlist = watchlists.find((w) => w.id === selectedWatchlistId);
    if (!currentWatchlist || !currentWatchlist.items || currentWatchlist.items.length === 0) {
      setFundsData([]);
      return;
    }
    const fundCodes = currentWatchlist.items.map((item) => item.fund_code);
    setFundsLoading(true);
    try {
      const [navsResponse, estimatesResponse] = await Promise.all([
        fundsAPI.batchUpdateNav(fundCodes),
        fundsAPI.batchEstimate(fundCodes, preferredSource),
      ]);
      setFundsData((prev) => {
        const source = prev.length > 0 ? prev : currentWatchlist.items;
        return source.map((item) => {
          const nav = navsResponse.data[item.fund_code] || {};
          const estimate = estimatesResponse.data[item.fund_code] || {};
          return {
            ...item,
            latest_nav: nav.latest_nav || estimate.latest_nav || item.latest_nav,
            latest_nav_date: nav.latest_nav_date || estimate.latest_nav_date || item.latest_nav_date,
            estimate_nav: estimate.estimate_nav || item.estimate_nav,
            estimate_growth: estimate.estimate_growth || item.estimate_growth,
            fund_name: estimate.fund_name || item.fund_name,
          };
        });
      });

      // 分组综合涨跌幅
      const estimates = estimatesResponse.data || {};
      const growths = currentWatchlist.items
        .map((item) => parseFloat(estimates[item.fund_code]?.estimate_growth))
        .filter((v) => !isNaN(v));
      if (growths.length > 0) {
        const avg = growths.reduce((a, b) => a + b, 0) / growths.length;
        setGroupGrowths((prev) => ({
          ...prev,
          [selectedWatchlistId]: parseFloat(avg.toFixed(2)),
        }));
      }
    } catch {
      setFundsData(currentWatchlist.items);
    } finally {
      setFundsLoading(false);
    }
  }, [selectedWatchlistId, watchlists, preferredSource]);

  // ==================== 搜索 / 添加 / 移除基金 ====================
  const handleSearch = async (keyword) => {
    if (!keyword || keyword.length < 2) { setFundOptions([]); return; }
    setSearchLoading(true);
    try {
      const response = await fundsAPI.search(keyword);
      setFundOptions(
        response.data.results.slice(0, 20).map((f) => ({
          value: f.fund_code,
          label: `${f.fund_code} - ${f.fund_name}`,
        }))
      );
    } catch { message.error('搜索失败'); }
    finally { setSearchLoading(false); }
  };

  const handleAddFund = async (fundCode) => {
    if (!selectedWatchlistId) { message.error('请先选择自选列表'); return; }
    if (!fundCode) { message.error('请输入基金代码'); return; }
    try {
      await watchlistsAPI.addItem(selectedWatchlistId, fundCode);
      message.success('添加成功');
      setSearchKeyword('');
      setFundOptions([]);
      await loadWatchlists();
      loadFundDetails();
    } catch (error) {
      message.error(error.response?.data?.error || '添加失败');
    }
  };

  const handleRemoveFund = async (fundCode) => {
    if (!selectedWatchlistId) return;
    try {
      await watchlistsAPI.removeItem(selectedWatchlistId, fundCode);
      message.success('移除成功');
      await loadWatchlists();
      loadFundDetails();
      if (selectedFund?.fund_code === fundCode) setSelectedFund(null);
    } catch { message.error('移除失败'); }
  };

  // ==================== 选中基金 → 加载图表数据 ====================
  const loadNavHistory = useCallback(async (code, range = '1M') => {
    setChartLoading(true);
    try {
      let params = {};
      if (range !== 'ALL') {
        const now = new Date();
        const startDate = new Date();
        switch (range) {
          case '1W': startDate.setDate(now.getDate() - 7); break;
          case '1M': startDate.setMonth(now.getMonth() - 1); break;
          case '3M': startDate.setMonth(now.getMonth() - 3); break;
          case '6M': startDate.setMonth(now.getMonth() - 6); break;
          case '1Y': startDate.setFullYear(now.getFullYear() - 1); break;
          case 'ALL': startDate.setFullYear(now.getFullYear() - 10); break;
          default: startDate.setMonth(now.getMonth() - 1);
        }
        params.start_date = startDate.toISOString().split('T')[0];
      }
      const response = await fundsAPI.navHistory(code, params);
      const data = response.data.sort((a, b) => new Date(a.nav_date) - new Date(b.nav_date));
      setNavHistory(data);
    } catch { setNavHistory([]); }
    finally { setChartLoading(false); }
  }, []);

  const loadFundPositions = useCallback(async (code) => {
    try {
      const response = await positionsAPI.listByFund(code);
      setPositions(response.data);
    } catch { setPositions([]); }
  }, []);

  const loadOperations = useCallback(async (code) => {
    try {
      const response = await positionsAPI.listOperations({ fund_code: code });
      setOperations(response.data);
    } catch { setOperations([]); }
  }, []);

  const handleSelectFund = useCallback((fund) => {
    setSelectedFund(fund);
    if (fund) {
      loadNavHistory(fund.fund_code, timeRange);
      loadFundPositions(fund.fund_code);
      loadOperations(fund.fund_code);
    }
  }, [loadNavHistory, loadFundPositions, loadOperations, timeRange]);

  // ==================== 数据源切换 ====================
  const handleSourceChange = async (source) => {
    try {
      await updatePreference(source);
      message.success(`已切换到${SOURCE_OPTIONS.find((o) => o.value === source)?.label}`);
    } catch { message.error('切换数据源失败'); }
  };

  // ==================== 挂载 & 定时刷新 ====================
  useEffect(() => { loadIndices(); loadWatchlists(); }, [loadIndices, loadWatchlists]);

  useEffect(() => {
    if (selectedWatchlistId) {
      loadFundDetails();
      intervalRef.current = setInterval(loadFundDetails, 30000);
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [selectedWatchlistId, loadFundDetails]);

  useEffect(() => {
    const i = setInterval(loadIndices, 30000);
    return () => clearInterval(i);
  }, [loadIndices]);

  // ==================== ECharts 净值走势图 ====================
  const chartOption = useMemo(() => {
    const ops = operations.map((op) => {
      const dateIndex = navHistory.findIndex((item) => item.nav_date === op.operation_date);
      if (dateIndex === -1) return null;
      return {
        name: op.operation_type === 'BUY' ? '买入' : '卖出',
        coord: [dateIndex, parseFloat(op.nav)],
        value: op.operation_type === 'BUY' ? '买' : '卖',
        itemStyle: { color: op.operation_type === 'BUY' ? '#cf1322' : '#3f8600' },
        label: { show: true, formatter: '{c}', color: '#fff' },
      };
    }).filter(Boolean);
    return {
      tooltip: { trigger: 'axis', axisPointer: { type: 'cross' } },
      xAxis: { type: 'category', data: navHistory.map((h) => h.nav_date) },
      yAxis: { type: 'value', scale: true },
      series: [{
        name: '单位净值',
        type: 'line',
        data: navHistory.map((h) => parseFloat(h.unit_nav)),
        smooth: true,
        lineStyle: { color: token.colorPrimary, width: 2 },
        itemStyle: { color: token.colorPrimary },
        symbol: 'circle',
        symbolSize: 4,
        areaStyle: { color: 'rgba(24,144,255,0.08)' },
        markPoint: { data: ops },
      }],
      grid: { left: '8%', right: '4%', top: 10, bottom: 20 },
    };
  }, [navHistory, operations, token.colorPrimary]);

  // ==================== 自选列表表格列 ====================
  const columns = [
    {
      title: '代码', dataIndex: 'fund_code', key: 'fund_code', width: 100,
      render: (code) => (
        <a onClick={() => {
          const fund = fundsData.find((f) => f.fund_code === code);
          handleSelectFund(fund || { fund_code: code, fund_name: code });
        }}>{code}</a>
      ),
    },
    {
      title: '名称', dataIndex: 'fund_name', key: 'fund_name', width: 160, ellipsis: true,
    },
    {
      title: '净值', dataIndex: 'latest_nav', key: 'latest_nav', width: 120,
      render: (v) => v ? `¥${parseFloat(v).toFixed(4)}` : '-',
    },
    {
      title: '涨跌', dataIndex: 'estimate_growth', key: 'estimate_growth', width: 100,
      render: (v) => {
        if (v == null) return '-';
        const num = parseFloat(v);
        return <span style={{ color: num >= 0 ? '#cf1322' : '#3f8600' }}>{num >= 0 ? '+' : ''}{num.toFixed(2)}%</span>;
      },
    },
    {
      title: '', key: 'action', width: 60, fixed: 'right',
      render: (_, record) => (
        <Popconfirm title="确定移除？" onConfirm={() => handleRemoveFund(record.fund_code)}>
          <Button type="link" danger size="small">移除</Button>
        </Popconfirm>
      ),
    },
  ];

  // ==================== 渲染：市场指数行情栏 ====================
  const renderIndexBar = () => (
    <Card size="small" style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ display: 'flex', gap: 20, overflowX: 'auto', flex: 1, paddingBottom: 4 }}>
          {indices.map((idx) => {
            const chg = idx.change_percent != null ? parseFloat(idx.change_percent) : null;
            return (
              <div key={idx.code} style={{ textAlign: 'center', minWidth: 90, flexShrink: 0 }}>
                <div style={{ fontSize: 12, color: token.colorTextSecondary }}>{idx.name}</div>
                <div style={{ fontSize: 16, fontWeight: 600, color: token.colorText }}>
                  {idx.price || '-'}
                </div>
                <div style={{
                  fontSize: 12,
                  color: chg != null ? (chg >= 0 ? '#cf1322' : '#3f8600') : token.colorTextSecondary,
                }}>
                  {chg != null ? `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%` : '-'}
                </div>
              </div>
            );
          })}
        </div>
        <Radio.Group
          value={preferredSource}
          onChange={(e) => handleSourceChange(e.target.value)}
          optionType="button"
          buttonStyle="solid"
          size="small"
          options={SOURCE_OPTIONS}
          style={{ flexShrink: 0, whiteSpace: 'nowrap' }}
        />
      </div>
    </Card>
  );

  // ==================== 渲染：左侧自选列表 ====================
  const renderWatchlistPanel = () => (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* 搜索添加基金 */}
      <Space.Compact style={{ marginBottom: 12 }}>
        <AutoComplete
          style={{ flex: 1 }}
          options={fundOptions}
          onSearch={handleSearch}
          onSelect={handleAddFund}
          placeholder="搜索基金代码或名称"
          value={searchKeyword}
          onChange={setSearchKeyword}
          notFoundContent={searchLoading ? <Spin size="small" /> : null}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && searchKeyword) handleAddFund(searchKeyword);
          }}
        />
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setModalVisible(true)} />
      </Space.Compact>

      {/* 自选列表 Tabs */}
      {watchlists.length === 0 ? (
        <Empty description="还没有自选列表" image={Empty.PRESENTED_IMAGE_SIMPLE}>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setModalVisible(true)}>
            创建自选列表
          </Button>
        </Empty>
      ) : (
        <Tabs
          activeKey={selectedWatchlistId}
          onChange={setSelectedWatchlistId}
          tabBarExtraContent={
            <Button type="text" size="small" icon={<PlusOutlined />} onClick={() => setModalVisible(true)} />
          }
          tabBarStyle={{ marginBottom: 8 }}
          items={watchlists.map((w) => {
            const growth = groupGrowths[w.id];
            return {
              key: w.id,
              label: (
                <span>
                  {w.name}
                  {growth !== undefined && (
                    <span style={{ marginLeft: 4, fontSize: 11, color: growth >= 0 ? '#cf1322' : '#3f8600' }}>
                      {growth >= 0 ? '+' : ''}{growth.toFixed(2)}%
                    </span>
                  )}
                </span>
              ),
              children: (
                <Table
                  columns={columns}
                  dataSource={fundsData}
                  loading={fundsLoading}
                  rowKey="fund_code"
                  pagination={false}
                  size="small"
                  scroll={{ y: 'calc(100vh - 420px)' }}
                  onRow={(record) => ({
                    onClick: () => handleSelectFund(record),
                    style: {
                      cursor: 'pointer',
                      background: selectedFund?.fund_code === record.fund_code ? token.colorFillSecondary : undefined,
                    },
                  })}
                />
              ),
            };
          })}
        />
      )}

      {/* 创建列表 Modal */}
      <Modal
        title="创建自选列表"
        open={modalVisible}
        onOk={handleCreate}
        onCancel={() => { setModalVisible(false); form.resetFields(); }}
        okText="创建" cancelText="取消"
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="列表名称" rules={[
            { required: true, message: '请输入列表名称' },
            { max: 50, message: '名称不能超过50个字符' },
          ]}>
            <Input placeholder="例如：我的自选" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );

  // ==================== 渲染：右侧图表区 ====================
  const renderChartPanel = () => {
    if (!selectedFund) {
      return (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          height: '100%', minHeight: 300, color: token.colorTextSecondary, fontSize: 14,
        }}>
          请在左侧选择一个基金查看详情
        </div>
      );
    }

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* 基金名称 + 实时估值 */}
        <Card size="small">
          <Row gutter={16} align="middle">
            <Col flex="auto">
              <Text strong style={{ fontSize: 16 }}>{selectedFund.fund_name || selectedFund.fund_code}</Text>
              <Text type="secondary" style={{ marginLeft: 8 }}>{selectedFund.fund_code}</Text>
            </Col>
            <Col>
              <Statistic
                title="最新净值"
                value={selectedFund.latest_nav ? `¥${parseFloat(selectedFund.latest_nav).toFixed(4)}` : '-'}
                valueStyle={{ fontSize: 16 }}
              />
            </Col>
            <Col>
              {selectedFund.estimate_growth != null ? (
                <Statistic
                  title="估算涨跌"
                  value={parseFloat(selectedFund.estimate_growth)}
                  precision={2}
                  suffix="%"
                  prefix={selectedFund.estimate_growth >= 0 ? '+' : ''}
                  valueStyle={{
                    fontSize: 16,
                    color: selectedFund.estimate_growth >= 0 ? '#cf1322' : '#3f8600',
                  }}
                />
              ) : (
                <Statistic title="估算涨跌" value="-" valueStyle={{ fontSize: 16 }} />
              )}
            </Col>
          </Row>
        </Card>

        {/* 净值走势图 */}
        <Card
          size="small"
          title="净值走势"
          extra={
            <Space size="small" wrap>
              {['1W', '1M', '3M', '6M', '1Y'].map((r) => (
                <Button
                  key={r} size="small"
                  type={timeRange === r ? 'primary' : 'default'}
                  onClick={() => { setTimeRange(r); loadNavHistory(selectedFund.fund_code, r); }}
                >{r === '1W' ? '1周' : r}</Button>
              ))}
            </Space>
          }
        >
          {chartLoading ? (
            <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>
          ) : navHistory.length > 0 ? (
            <ReactECharts option={chartOption} style={{ height: isMobile ? 280 : 340 }} />
          ) : (
            <Empty description="暂无历史数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          )}
        </Card>

        {/* 我的持仓 */}
        {positions.length > 0 && (
          <Card size="small" title="我的持仓">
            <Table
              dataSource={positions}
              rowKey="id"
              pagination={false}
              size="small"
              columns={[
                { title: '账户', dataIndex: 'account_name', key: 'account_name' },
                { title: '份额', dataIndex: 'holding_share', key: 'holding_share', render: (v) => parseFloat(v).toFixed(2) },
                { title: '成本', dataIndex: 'holding_cost', key: 'holding_cost', render: (v) => `¥${parseFloat(v).toFixed(2)}` },
                { title: '市值', key: 'market_value', render: (_, record) => {
                  const mv = parseFloat(record.holding_share) * parseFloat(selectedFund.latest_nav || 0);
                  return `¥${mv.toFixed(2)}`;
                }},
                { title: '盈亏', key: 'profit', render: (_, record) => {
                  const mv = parseFloat(record.holding_share) * parseFloat(selectedFund.latest_nav || 0);
                  const cost = parseFloat(record.holding_cost);
                  const p = mv - cost;
                  const pr = cost > 0 ? ((p / cost) * 100).toFixed(2) : '0.00';
                  return <span style={{ color: p >= 0 ? '#cf1322' : '#3f8600' }}>{p >= 0 ? '+' : ''}¥{p.toFixed(2)} ({pr}%)</span>;
                }},
              ]}
            />
          </Card>
        )}

        {/* 最近30日交易记录 */}
        {operations.length > 0 && (
          <Card size="small" title="最近交易记录">
            <Table
              dataSource={operations.slice(0, 30)}
              rowKey="id"
              pagination={false}
              size="small"
              columns={[
                { title: '日期', dataIndex: 'operation_date', key: 'operation_date', width: 110 },
                { title: '操作', dataIndex: 'operation_type', key: 'operation_type', width: 60,
                  render: (v) => <span style={{ color: v === 'BUY' ? '#cf1322' : '#3f8600' }}>{v === 'BUY' ? '买入' : '卖出'}</span>,
                },
                { title: '净值', dataIndex: 'nav', key: 'nav', render: (v) => `¥${parseFloat(v).toFixed(4)}` },
                { title: '金额', dataIndex: 'amount', key: 'amount', render: (v) => `¥${parseFloat(v).toFixed(2)}` },
                { title: '份额', dataIndex: 'share', key: 'share', render: (v) => parseFloat(v).toFixed(2) },
              ]}
            />
          </Card>
        )}
      </div>
    );
  };

  // ==================== 移动端 Tab ====================
  const renderMobile = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {renderIndexBar()}
      <Tabs
        activeKey={mobileTab}
        onChange={setMobileTab}
        items={[
          {
            key: 'watchlist',
            label: '自选列表',
            children: renderWatchlistPanel(),
          },
          {
            key: 'chart',
            label: '走势图表',
            children: renderChartPanel(),
          },
        ]}
      />
    </div>
  );

  // ==================== 桌面端 ====================
  const renderDesktop = () => (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 112px)', gap: 12 }}>
      {renderIndexBar()}
      <div style={{ display: 'flex', flex: 1, gap: 12, minHeight: 0 }}>
        {/* 左侧面板 */}
        <Card
          size="small"
          style={{ width: 280, flexShrink: 0, overflow: 'auto' }}
          styles={{ body: { padding: 12 } }}
        >
          {renderWatchlistPanel()}
        </Card>
        {/* 右侧内容 */}
        <div style={{ flex: 1, overflow: 'auto' }}>
          {renderChartPanel()}
        </div>
      </div>
    </div>
  );

  if (loading && watchlists.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '50px 0' }}>
        <Spin tip="加载中..." />
      </div>
    );
  }

  return isMobile ? renderMobile() : renderDesktop();
};

export default HomePage;
