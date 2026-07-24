import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  Clock3,
  CreditCard,
  Loader2,
  LogIn,
  RefreshCw,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  gatewayAccount,
  gatewayCreatePackageOrder,
  gatewayLogin,
  gatewayPackageCatalog,
  gatewayPackageOrderStatus,
  gatewayQuota,
  listProviders,
  type GatewayCatalogPackage,
  type GatewayPackageOrder,
} from "@/lib/api";
import { SettingsSection } from "@/features/settings/settings-section";

type PaymentProvider = "alipay" | "wechat";

const formatYuan = (micro: number) => `¥${(micro / 1_000_000).toFixed(2)}`;

const formatQuota = (value: number, meter: string) => {
  if (meter === "sale_amount" || meter === "cost_amount") return formatYuan(value);
  if (meter === "image_count") return `${value} 张`;
  if (meter === "token") return `${value.toLocaleString()} token`;
  return `${value.toLocaleString()} 次`;
};

const formatDate = (value?: string) => {
  if (!value) return "永久";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString("zh-CN");
};

export function QuotaCenter() {
  const queryClient = useQueryClient();
  const [selectedPackage, setSelectedPackage] = useState<GatewayCatalogPackage | null>(null);
  const [paymentProvider, setPaymentProvider] = useState<PaymentProvider>("alipay");
  const [activeOrder, setActiveOrder] = useState<GatewayPackageOrder | null>(null);
  const [orderStartedAt, setOrderStartedAt] = useState(0);

  const providersQuery = useQuery({ queryKey: ["providers"], queryFn: listProviders });
  const provider = providersQuery.data?.find((item) => item.builtIn);
  const accountQuery = useQuery({
    queryKey: ["gateway-account", provider?.id],
    queryFn: () => gatewayAccount(provider!.id),
    enabled: Boolean(provider),
    retry: false,
  });
  const loggedIn = Boolean(accountQuery.data?.loggedIn);
  const quotaQuery = useQuery({
    queryKey: ["gateway-quota", provider?.id],
    queryFn: () => gatewayQuota(provider!.id),
    enabled: Boolean(provider && loggedIn),
    retry: false,
  });
  const catalogQuery = useQuery({
    queryKey: ["gateway-package-catalog", provider?.id],
    queryFn: () => gatewayPackageCatalog(provider!.id),
    enabled: Boolean(provider && loggedIn),
    retry: false,
  });
  const login = useMutation({
    mutationFn: () => gatewayLogin(provider!.id),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["gateway-account", provider?.id] }),
        queryClient.invalidateQueries({ queryKey: ["gateway-quota", provider?.id] }),
        queryClient.invalidateQueries({ queryKey: ["gateway-package-catalog", provider?.id] }),
      ]);
    },
  });
  const createOrder = useMutation({
    mutationFn: ({
      packageId,
      method,
    }: {
      packageId: number;
      method: PaymentProvider;
    }) => gatewayCreatePackageOrder(provider!.id, packageId, method),
    onSuccess: (order) => {
      setActiveOrder(order);
      setOrderStartedAt(Date.now());
      setSelectedPackage(null);
    },
  });
  const orderQuery = useQuery({
    queryKey: ["gateway-package-order", provider?.id, activeOrder?.orderNo],
    queryFn: () => gatewayPackageOrderStatus(provider!.id, activeOrder!.orderNo),
    enabled: Boolean(provider && activeOrder),
    retry: false,
    refetchInterval: (query) => {
      if (query.state.data?.status !== 0) return false;
      return Date.now() - orderStartedAt < 10 * 60 * 1000 ? 3_000 : false;
    },
  });

  useEffect(() => {
    if (orderQuery.data?.status !== 1 || !provider) return;
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: ["gateway-quota", provider.id] }),
      queryClient.invalidateQueries({ queryKey: ["gateway-package-catalog", provider.id] }),
      queryClient.invalidateQueries({ queryKey: ["gateway-account", provider.id] }),
    ]);
  }, [orderQuery.data?.status, provider, queryClient]);

  const channels = catalogQuery.data?.paymentChannels;
  const openPurchase = (item: GatewayCatalogPackage) => {
    setSelectedPackage(item);
    setPaymentProvider(channels?.alipay ? "alipay" : "wechat");
  };

  if (!provider || accountQuery.data?.supported === false) {
    return (
      <SettingsSection title="额度中心">
        <Alert>
          <AlertTitle>当前供应商不支持额度中心</AlertTitle>
          <AlertDescription>切换到 Tietiezhi 官方中转站后可使用。</AlertDescription>
        </Alert>
      </SettingsSection>
    );
  }

  if (!loggedIn) {
    return (
      <SettingsSection
        title="登录中转站"
        description="登录是可选的。登录后可以查看额度、套餐和消费记录，也可以直接购买套餐。"
      >
        <Button className="w-fit" disabled={login.isPending} onClick={() => login.mutate()}>
          {login.isPending ? <Loader2 className="animate-spin" /> : <LogIn />}
          登录当前中转站
        </Button>
        {login.isError && (
          <p className="text-destructive text-sm">{String(login.error)}</p>
        )}
      </SettingsSection>
    );
  }

  const account = accountQuery.data?.account;
  const quota = quotaQuery.data;
  const currentOrder = orderQuery.data;

  return (
    <div className="flex flex-col gap-7">
      <SettingsSection
        title={account?.nickname || account?.email || "额度中心"}
        description={account?.email}
        action={
          <Button
            variant="outline"
            size="sm"
            disabled={quotaQuery.isFetching}
            onClick={() => void quotaQuery.refetch()}
          >
            <RefreshCw className={quotaQuery.isFetching ? "animate-spin" : ""} />
            刷新
          </Button>
        }
      >
        {quotaQuery.isError ? (
          <Alert variant="destructive">
            <AlertTitle>额度读取失败</AlertTitle>
            <AlertDescription>{String(quotaQuery.error)}</AlertDescription>
          </Alert>
        ) : (
          <div className="grid gap-3 sm:grid-cols-3">
            <Card size="sm">
              <CardHeader>
                <CardDescription>可用余额</CardDescription>
                <CardTitle className="text-xl">
                  {quota ? formatYuan(quota.wallet.balanceMicro) : "读取中"}
                </CardTitle>
              </CardHeader>
            </Card>
            <Card size="sm">
              <CardHeader>
                <CardDescription>累计充值</CardDescription>
                <CardTitle className="text-xl">
                  {quota ? formatYuan(quota.wallet.totalTopupMicro) : "读取中"}
                </CardTitle>
              </CardHeader>
            </Card>
            <Card size="sm">
              <CardHeader>
                <CardDescription>累计消费</CardDescription>
                <CardTitle className="text-xl">
                  {quota ? formatYuan(quota.wallet.totalSpendMicro) : "读取中"}
                </CardTitle>
              </CardHeader>
            </Card>
          </div>
        )}
      </SettingsSection>

      {activeOrder && (
        <Alert>
          {currentOrder?.status === 1 ? <CheckCircle2 /> : <Clock3 />}
          <AlertTitle>
            {currentOrder?.status === 1 ? "支付完成，额度已刷新" : "等待支付完成"}
          </AlertTitle>
          <AlertDescription>
            {currentOrder?.status === 1
              ? `${activeOrder.packageName} 已到账。`
              : `已在系统浏览器打开 ${activeOrder.provider === "alipay" ? "支付宝" : "微信支付"}，桌面端正在查询订单 ${activeOrder.orderNo}。`}
          </AlertDescription>
        </Alert>
      )}

      <SettingsSection title="我的套餐" description="套餐额度会优先于钱包余额使用。">
        {quota?.packages.length ? (
          <div className="flex flex-col divide-y rounded-lg border">
            {quota.packages.map((item) => (
              <div key={item.id} className="flex items-center justify-between gap-4 px-4 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{item.name}</span>
                    <Badge variant={item.status === "active" ? "secondary" : "outline"}>
                      {item.status === "active" ? "生效中" : item.status}
                    </Badge>
                  </div>
                  <p className="text-muted-foreground mt-1 text-xs">
                    有效期至 {formatDate(item.validUntil)}
                  </p>
                </div>
                <strong className="shrink-0 text-sm">
                  剩余 {formatQuota(item.windowRemaining, item.meterBy)}
                </strong>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">暂无可用套餐。</p>
        )}
      </SettingsSection>

      <Separator />

      <SettingsSection title="购买套餐" description="确认套餐和支付方式后，将在系统浏览器完成付款。">
        {catalogQuery.isError && (
          <Alert variant="destructive">
            <AlertTitle>套餐目录读取失败</AlertTitle>
            <AlertDescription>{String(catalogQuery.error)}</AlertDescription>
          </Alert>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          {catalogQuery.data?.items.map((item) => (
            <Card key={item.id} size="sm">
              <CardHeader>
                <CardTitle>{item.name}</CardTitle>
                <CardDescription>{item.description}</CardDescription>
                <CardAction>
                  <strong>{formatYuan(item.priceMicro)}</strong>
                </CardAction>
              </CardHeader>
              <CardContent className="flex items-end justify-between gap-4">
                <div className="text-muted-foreground text-xs">
                  <p>额度 {formatQuota(item.quotaPerWindow, item.meterBy)}</p>
                  <p>{item.validDays > 0 ? `有效期 ${item.validDays} 天` : "永久有效，用完为止"}</p>
                </div>
                <Button
                  size="sm"
                  disabled={!channels?.alipay && !channels?.wechat}
                  onClick={() => openPurchase(item)}
                >
                  购买
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
        {catalogQuery.data && !channels?.alipay && !channels?.wechat && (
          <p className="text-muted-foreground text-sm">支付渠道尚未启用，套餐暂不可购买。</p>
        )}
      </SettingsSection>

      <SettingsSection title="最近消费">
        {quota?.recentConsumption.length ? (
          <div className="flex flex-col divide-y rounded-lg border">
            {quota.recentConsumption.map((item) => (
              <div key={item.requestId} className="flex items-center justify-between gap-4 px-4 py-2.5 text-sm">
                <div className="min-w-0">
                  <p className="truncate font-medium">{item.publicModel}</p>
                  <p className="text-muted-foreground text-xs">
                    {new Date(item.createdAt).toLocaleString("zh-CN")}
                  </p>
                </div>
                <span className="shrink-0">
                  {item.userPackageId > 0 ? "套餐扣减" : formatYuan(item.amountMicro)}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">暂无消费记录。</p>
        )}
      </SettingsSection>

      <AlertDialog
        open={Boolean(selectedPackage)}
        onOpenChange={(open) => !open && setSelectedPackage(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认购买 {selectedPackage?.name}</AlertDialogTitle>
            <AlertDialogDescription>
              请确认价格和付款方式。确认后会打开系统浏览器，支付完成后本页自动刷新额度。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex flex-col gap-4">
            <div className="rounded-lg border p-3">
              <p className="text-muted-foreground text-xs">应付金额</p>
              <p className="mt-1 text-xl font-semibold">
                {selectedPackage ? formatYuan(selectedPackage.priceMicro) : ""}
              </p>
            </div>
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium">支付方式</span>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  type="button"
                  variant={paymentProvider === "alipay" ? "default" : "outline"}
                  disabled={!channels?.alipay}
                  onClick={() => setPaymentProvider("alipay")}
                >
                  支付宝
                </Button>
                <Button
                  type="button"
                  variant={paymentProvider === "wechat" ? "default" : "outline"}
                  disabled={!channels?.wechat}
                  onClick={() => setPaymentProvider("wechat")}
                >
                  微信支付
                </Button>
              </div>
            </div>
            <ol className="text-muted-foreground list-inside list-decimal space-y-1 text-xs">
              <li>确认套餐、价格和支付方式</li>
              <li>在系统浏览器完成付款</li>
              <li>Tietiezhi 查询到账并刷新额度</li>
            </ol>
            {createOrder.isError && (
              <p className="text-destructive text-sm">{String(createOrder.error)}</p>
            )}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <Button
              disabled={createOrder.isPending || !selectedPackage}
              onClick={() => {
                if (!selectedPackage) return;
                createOrder.mutate({
                  packageId: selectedPackage.id,
                  method: paymentProvider,
                });
              }}
            >
              {createOrder.isPending ? <Loader2 className="animate-spin" /> : <CreditCard />}
              确认并打开浏览器
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
